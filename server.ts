import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as XLSX from 'xlsx';
import {
  initializeDatabase,
  closeDatabase,
  createBoothWithOfficers,
  generateEndOfDayReport,
  getAdminByToken,
  getAdminDashboardState,
  getBoothState,
  getBoothSummary,
  getOfficerByToken,
  getOfficersPresence,
  listBooths,
  loginAdmin,
  loginOfficer,
  logoutAdmin,
  logoutOfficer,
  markVoterAsDead,
  markVoterAsVoted,
  replaceElectoralRoll,
  revertVoterStatus,
  setBoothLock,
} from './src/server/db.ts';
import type {
  AdminUser,
  ImportPreviewColumnMap,
  OfficerRole,
  WsServerEvent,
} from './src/types/election.ts';

const PORT = Number(process.env.PORT ?? 3000);
const app = express();
app.use(express.json({ limit: '15mb' }));

const asyncRoute =
  (handler: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

interface BoothSocketClient {
  ws: WebSocket;
  boothId: string;
  officerId: string;
  officerName: string;
}

const boothClients = new Map<string, Set<BoothSocketClient>>();
const adminClients = new Set<WebSocket>();

function getOnlineOfficerIds(boothId: string): Set<string> {
  const set = boothClients.get(boothId);
  const ids = new Set<string>();
  if (!set) return ids;
  for (const client of set) {
    if (client.ws.readyState === WebSocket.OPEN) {
      ids.add(client.officerId);
    }
  }
  return ids;
}

function getOnlineOfficerMap(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const [boothId] of boothClients) {
    map.set(boothId, getOnlineOfficerIds(boothId));
  }
  return map;
}

async function broadcastAdminUpdate(): Promise<void> {
  if (adminClients.size === 0) return;
  try {
    const payload = JSON.stringify({
      type: 'admin:updated',
      state: await getAdminDashboardState(getOnlineOfficerMap()),
    } satisfies WsServerEvent);
    for (const ws of adminClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  } catch {
    console.error('Unable to refresh admin dashboard.');
  }
}

async function broadcastToBooth(boothId: string, event: WsServerEvent): Promise<void> {
  const set = boothClients.get(boothId);
  if (set) {
    const payload = JSON.stringify(event);
    for (const client of set) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    }
  }
  await broadcastAdminUpdate();
}

type WsIdentity =
  | {
      kind: 'officer';
      officer: {
        id: string;
        booth_id: string;
        username: string;
        full_name: string;
        role: OfficerRole;
      };
    }
  | {
      kind: 'admin';
      admin: AdminUser;
    };

server.on('upgrade', async (request, socket, head) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
      return;
    }

    const token = url.searchParams.get('token') ?? '';
    const officer = await getOfficerByToken(token);
    if (officer) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, {
          kind: 'officer',
          officer,
        } satisfies WsIdentity);
      });
      return;
    }

    const admin = await getAdminByToken(token);
    if (admin) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, {
          kind: 'admin',
          admin,
        } satisfies WsIdentity);
      });
      return;
    }

    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  } catch {
    socket.destroy();
  }
});

wss.on('connection', async (ws: WebSocket, identity: WsIdentity) => {
  try {
    if (identity.kind === 'admin') {
      adminClients.add(ws);
      ws.on('close', () => {
        adminClients.delete(ws);
      });
      ws.send(
        JSON.stringify({
          type: 'admin:init',
          state: await getAdminDashboardState(getOnlineOfficerMap()),
        } satisfies WsServerEvent)
      );

      return;
    }

    const officer = identity.officer;
    const boothId = officer.booth_id;
    let clients = boothClients.get(boothId);
    if (!clients) {
      clients = new Set();
      boothClients.set(boothId, clients);
    }

    const clientInfo: BoothSocketClient = {
      ws,
      boothId,
      officerId: officer.id,
      officerName: officer.full_name,
    };
    clients.add(clientInfo);

    ws.on('close', async () => {
      try {
        clients?.delete(clientInfo);
        if (clients && clients.size === 0) {
          boothClients.delete(boothId);
        }
        await broadcastToBooth(boothId, {
          type: 'presence:updated',
          officers: await getOfficersPresence(boothId, getOnlineOfficerIds(boothId)),
        });
      } catch {
        console.error('Unable to broadcast officer disconnection.');
      }
    });

    const onlineIds = getOnlineOfficerIds(boothId);
    const state = await getBoothState(boothId, onlineIds);
    if (state && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'init',
          state,
          onlineOfficerIds: Array.from(onlineIds),
        } satisfies WsServerEvent)
      );
    }

    await broadcastToBooth(boothId, {
      type: 'presence:updated',
      officers: await getOfficersPresence(boothId, getOnlineOfficerIds(boothId)),
    });
  } catch {
    ws.close(1011, 'Database operation failed');
  }
});

async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const officer = await getOfficerByToken(token);
  if (!officer) {
    res.status(401).json({
      error: 'Authentication required. Please log in to a booth terminal.',
    });
    return;
  }
  (req as express.Request & { officer?: typeof officer; token?: string }).officer = officer;
  (req as express.Request & { officer?: typeof officer; token?: string }).token = token;
  next();
}

function getAuthedOfficer(req: express.Request) {
  return req as express.Request & {
    officer: {
      id: string;
      booth_id: string;
      username: string;
      full_name: string;
      role: OfficerRole;
    };
    token: string;
  };
}

// --- Public Booth & Auth Routes ---

app.get(
  '/api/booths',
  asyncRoute(async (_req, res) => {
    res.json({ booths: await listBooths() });
  })
);

app.post(
  '/api/booths',
  asyncRoute(async (req, res) => {
    try {
      const { id, name, constituency, electionTitle, officers } = req.body ?? {};
      const result = await createBoothWithOfficers({
        id: String(id ?? ''),
        name: String(name ?? ''),
        constituency: String(constituency ?? ''),
        electionTitle: String(electionTitle ?? ''),
        officers: Array.isArray(officers) ? officers : [],
      });
      await broadcastAdminUpdate();
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to create booth.',
      });
    }
  })
);

app.post(
  '/api/auth/login',
  asyncRoute(async (req, res) => {
    try {
      const { boothId, username, passcode } = req.body ?? {};
      const session = await loginOfficer(
        String(boothId ?? ''),
        String(username ?? ''),
        String(passcode ?? '')
      );
      await broadcastToBooth(session.booth.id, {
        type: 'presence:updated',
        officers: await getOfficersPresence(
          session.booth.id,
          getOnlineOfficerIds(session.booth.id)
        ),
      });
      res.json(session);
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : 'Login failed.' });
    }
  })
);

app.post(
  '/api/auth/logout',
  asyncRoute(requireAuth),
  asyncRoute(async (req, res) => {
    const { token } = getAuthedOfficer(req);
    const boothId = await logoutOfficer(token);
    if (boothId) {
      await broadcastToBooth(boothId, {
        type: 'presence:updated',
        officers: await getOfficersPresence(boothId, getOnlineOfficerIds(boothId)),
      });
    }
    res.json({ ok: true });
  })
);

app.get(
  '/api/auth/session',
  asyncRoute(requireAuth),
  asyncRoute(async (req, res) => {
    const { officer, token } = getAuthedOfficer(req);
    const booth = await getBoothSummary(officer.booth_id);
    if (!booth) {
      res.status(404).json({ error: 'Booth not found.' });
      return;
    }
    res.json({
      token,
      booth,
      officer: {
        id: officer.id,
        username: officer.username,
        full_name: officer.full_name,
        role: officer.role,
      },
    });
  })
);

// --- Template Download ---

app.get(
  '/api/template',
  asyncRoute(async (req, res) => {
    const format = String(req.query.format ?? 'xlsx').toLowerCase();
    const sampleRows = [
      {
        Serial_No: 1,
        Voter_ID: 'VTR901001',
        Full_Name: 'Srinivasulu Naidu',
        Guardian_Name: 'Venkataiah Naidu',
        Age: 42,
        Gender: 'Male',
        Address: 'H.No 4-12, Main Bazaar',
        Part_No: 'PART-01',
      },
      {
        Serial_No: 2,
        Voter_ID: 'VTR901002',
        Full_Name: 'Padmavathi Devi',
        Guardian_Name: 'Srinivasulu Naidu',
        Age: 38,
        Gender: 'Female',
        Address: 'H.No 4-12, Main Bazaar',
        Part_No: 'PART-01',
      },
      {
        Serial_No: 3,
        Voter_ID: 'VTR901003',
        Full_Name: 'Abdul Rahman',
        Guardian_Name: 'Shaik Kareem',
        Age: 55,
        Gender: 'Male',
        Address: 'H.No 4-19, Mosque Lane',
        Part_No: 'PART-01',
      },
      {
        Serial_No: 4,
        Voter_ID: 'VTR901004',
        Full_Name: 'Anusha Reddy',
        Guardian_Name: 'Pratap Reddy',
        Age: 24,
        Gender: 'Female',
        Address: 'H.No 4-25, School Colony',
        Part_No: 'PART-01',
      },
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(sampleRows);
    XLSX.utils.book_append_sheet(wb, ws, 'Electoral_Roll');

    if (format === 'csv') {
      const csv = XLSX.utils.sheet_to_csv(ws);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="booth_voter_roll_template.csv"');
      res.send(csv);
      return;
    }

    const buffer = XLSX.write(wb, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="booth_voter_roll_template.xlsx"');
    res.send(buffer);
  })
);

// --- Protected Booth Operations ---

app.get(
  '/api/booths/:boothId/state',
  asyncRoute(requireAuth),
  asyncRoute(async (req, res) => {
    const { officer } = getAuthedOfficer(req);
    const boothId = String(req.params.boothId);
    if (officer.booth_id !== boothId) {
      res.status(403).json({ error: 'Access denied for this booth.' });
      return;
    }
    const state = await getBoothState(boothId, getOnlineOfficerIds(boothId));
    if (!state) {
      res.status(404).json({ error: 'Booth not found.' });
      return;
    }
    res.json(state);
  })
);

app.post(
  '/api/booths/:boothId/voters/:voterRecordId/mark-voted',
  asyncRoute(requireAuth),
  asyncRoute(async (req, res) => {
    const { officer } = getAuthedOfficer(req);
    const boothId = String(req.params.boothId);
    const voterRecordId = Number(req.params.voterRecordId);

    if (officer.booth_id !== boothId) {
      res.status(403).json({ error: 'Access denied for this booth.' });
      return;
    }

    const result = await markVoterAsVoted(boothId, voterRecordId, {
      id: officer.id,
      full_name: officer.full_name,
    });

    if (!result.ok) {
      if (result.code === 'LOCKED') {
        res.status(423).json({
          error: 'Poll is closed for this booth. Reopen poll to mark votes.',
        });
        return;
      }
      if (result.code === 'MARKED_DEAD' && result.voter && result.auditEntry && result.stats) {
        await broadcastToBooth(boothId, {
          type: 'fraud:blocked',
          voter: result.voter,
          attemptedBy: officer.full_name,
          auditEntry: result.auditEntry,
          stats: result.stats,
        });
        await broadcastAdminUpdate();
        res.status(409).json({
          error: `Blocked: ${result.voter.full_name} (Serial #${result.voter.serial_no}) was marked DEAD by ${result.voter.marked_dead_by_officer_name ?? 'an officer'}${result.voter.marked_dead_by_officer_role ? ` (${result.voter.marked_dead_by_officer_role})` : ''}.`,
          voter: result.voter,
        });
        return;
      }
      if (result.code === 'ALREADY_VOTED' && result.voter && result.auditEntry && result.stats) {
        await broadcastToBooth(boothId, {
          type: 'fraud:blocked',
          voter: result.voter,
          attemptedBy: officer.full_name,
          auditEntry: result.auditEntry,
          stats: result.stats,
        });
        await broadcastAdminUpdate();
        res.status(409).json({
          error: `Duplicate vote blocked: ${result.voter.full_name} (Serial #${result.voter.serial_no}) was already marked VOTED by ${result.voter.verified_by_officer_name ?? 'another officer'}.`,
          voter: result.voter,
        });
        return;
      }
      res.status(404).json({ error: 'Voter record not found.' });
      return;
    }

    await broadcastToBooth(boothId, {
      type: 'voter:updated',
      voter: result.voter,
      stats: result.stats,
      auditEntry: result.auditEntry,
    });
    await broadcastAdminUpdate();

    res.json({
      voter: result.voter,
      stats: result.stats,
      auditEntry: result.auditEntry,
    });
  })
);

app.post(
  '/api/booths/:boothId/voters/:voterRecordId/mark-dead',
  asyncRoute(requireAuth),
  asyncRoute(async (req, res) => {
    const { officer } = getAuthedOfficer(req);
    const boothId = String(req.params.boothId);
    const voterRecordId = Number(req.params.voterRecordId);

    if (officer.booth_id !== boothId) {
      res.status(403).json({ error: 'Access denied for this booth.' });
      return;
    }

    const note = String(req.body?.note ?? '');
    const result = await markVoterAsDead(boothId, voterRecordId, note, {
      id: officer.id,
      full_name: officer.full_name,
      role: officer.role,
    });

    if (!result.ok) {
      if (result.code === 'LOCKED') {
        res.status(423).json({
          error: 'Poll is closed for this booth. Reopen poll to update records.',
        });
        return;
      }
      if (result.code === 'ALREADY_VOTED' && result.voter) {
        res.status(409).json({
          error: `Cannot mark as Dead: ${result.voter.full_name} (Serial #${result.voter.serial_no}) was already marked VOTED by ${result.voter.verified_by_officer_name ?? 'an officer'}. Presiding Officer must revert first.`,
          voter: result.voter,
        });
        return;
      }
      if (result.code === 'ALREADY_DEAD' && result.voter) {
        res.status(409).json({
          error: `${result.voter.full_name} (Serial #${result.voter.serial_no}) was already marked DEAD by ${result.voter.marked_dead_by_officer_name ?? 'an officer'}.`,
          voter: result.voter,
        });
        return;
      }
      res.status(404).json({ error: 'Voter record not found.' });
      return;
    }

    await broadcastToBooth(boothId, {
      type: 'voter:updated',
      voter: result.voter,
      stats: result.stats,
      auditEntry: result.auditEntry,
    });
    await broadcastAdminUpdate();

    res.json({
      voter: result.voter,
      stats: result.stats,
      auditEntry: result.auditEntry,
    });
  })
);

app.post(
  '/api/booths/:boothId/voters/:voterRecordId/revert',
  asyncRoute(requireAuth),
  asyncRoute(async (req, res) => {
    const { officer } = getAuthedOfficer(req);
    const boothId = String(req.params.boothId);
    const voterRecordId = Number(req.params.voterRecordId);

    if (officer.booth_id !== boothId) {
      res.status(403).json({ error: 'Access denied for this booth.' });
      return;
    }

    try {
      const reason = String(req.body?.reason ?? '');
      const result = await revertVoterStatus(boothId, voterRecordId, reason, officer);

      await broadcastToBooth(boothId, {
        type: 'voter:updated',
        voter: result.voter,
        stats: result.stats,
        auditEntry: result.auditEntry,
      });
      await broadcastAdminUpdate();

      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to revert status.',
      });
    }
  })
);

function detectColumnMapping(headers: string[]): ImportPreviewColumnMap {
  const findMatch = (patterns: RegExp[]): string => {
    for (const pattern of patterns) {
      const match = headers.find((h) => pattern.test(h.trim().toLowerCase()));
      if (match) return match;
    }
    return '';
  };

  return {
    serial_no: findMatch([/^(serial|sr|sl)[_\s.-]*(no|num|number)?$/, /^s\.?no$/]),
    voter_id: findMatch([/voter[_\s.-]*id/, /epic/, /id[_\s.-]*(no|num|number)/, /card[_\s.-]*no/]),
    full_name: findMatch([/^(full[_\s.-]*)?name$/, /voter[_\s.-]*name/, /elector[_\s.-]*name/]),
    guardian_name: findMatch([/guardian/, /father/, /mother/, /husband/, /spouse/, /relative/]),
    age: findMatch([/^age$/]),
    gender: findMatch([/^gender$/, /^sex$/]),
    address: findMatch([/address/, /house/, /locality/, /ward/]),
    part_no: findMatch([/part/, /section/, /booth/]),
  };
}

app.post(
  '/api/booths/:boothId/import/preview',
  asyncRoute(requireAuth),
  asyncRoute(async (req, res) => {
    const { officer } = getAuthedOfficer(req);
    const boothId = String(req.params.boothId);
    if (officer.booth_id !== boothId) {
      res.status(403).json({ error: 'Access denied for this booth.' });
      return;
    }

    try {
      const fileName = String(req.body?.fileName ?? 'electoral_roll.xlsx');
      const base64Data = String(req.body?.base64Data ?? '');
      if (!base64Data) {
        res.status(400).json({ error: 'No spreadsheet content received.' });
        return;
      }

      const buffer = Buffer.from(base64Data, 'base64');
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        res.status(400).json({ error: 'The uploaded spreadsheet contains no sheets.' });
        return;
      }

      const sheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: '',
      });

      if (rawRows.length === 0) {
        res.status(400).json({ error: 'No voter rows were found in the uploaded file.' });
        return;
      }

      const headers = Object.keys(rawRows[0] ?? {});
      const detectedMap = detectColumnMapping(headers);

      res.json({
        fileName,
        sheetName: firstSheetName,
        headers,
        detectedMap,
        totalRows: rawRows.length,
        rawRows,
      });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? `Failed to parse spreadsheet: ${err.message}`
            : 'Failed to parse spreadsheet.',
      });
    }
  })
);

app.post(
  '/api/booths/:boothId/import/confirm',
  asyncRoute(requireAuth),
  asyncRoute(async (req, res) => {
    const { officer } = getAuthedOfficer(req);
    const boothId = String(req.params.boothId);
    if (officer.booth_id !== boothId) {
      res.status(403).json({ error: 'Access denied for this booth.' });
      return;
    }

    try {
      const fileName = String(req.body?.fileName ?? 'electoral_roll.xlsx');
      const columnMap = (req.body?.columnMap ?? {}) as ImportPreviewColumnMap;
      const rawRows = (req.body?.rawRows ?? []) as Array<Record<string, unknown>>;

      if (!columnMap.voter_id || !columnMap.full_name) {
        res.status(400).json({ error: 'Please map both Voter ID and Full Name columns.' });
        return;
      }

      const seenSerials = new Set<number>();
      const seenVoterIds = new Set<string>();
      const normalizedRows: Array<{
        serial_no: number;
        voter_id: string;
        full_name: string;
        guardian_name: string;
        age: number | null;
        gender: string;
        address: string;
        part_no: string;
      }> = [];

      let autoSerial = 1;
      for (const row of rawRows) {
        const voterIdRaw = String(row[columnMap.voter_id] ?? '')
          .trim()
          .toUpperCase();
        const fullNameRaw = String(row[columnMap.full_name] ?? '').trim();
        if (!voterIdRaw || !fullNameRaw) continue;

        if (seenVoterIds.has(voterIdRaw)) {
          throw new Error(`Duplicate Voter ID found in file: ${voterIdRaw}`);
        }
        seenVoterIds.add(voterIdRaw);

        let serialNo = columnMap.serial_no ? Number(row[columnMap.serial_no]) : autoSerial;
        if (!Number.isFinite(serialNo) || serialNo <= 0) {
          serialNo = autoSerial;
        }
        while (seenSerials.has(serialNo)) {
          serialNo += 1;
        }
        seenSerials.add(serialNo);
        autoSerial = Math.max(autoSerial + 1, serialNo + 1);

        const ageParsed = columnMap.age ? Number(row[columnMap.age]) : NaN;
        const age = Number.isFinite(ageParsed) && ageParsed > 0 ? Math.round(ageParsed) : null;

        normalizedRows.push({
          serial_no: Math.round(serialNo),
          voter_id: voterIdRaw,
          full_name: fullNameRaw,
          guardian_name: columnMap.guardian_name
            ? String(row[columnMap.guardian_name] ?? '').trim()
            : '',
          age,
          gender: columnMap.gender
            ? String(row[columnMap.gender] ?? '').trim() || 'Other'
            : 'Other',
          address: columnMap.address ? String(row[columnMap.address] ?? '').trim() : '',
          part_no: columnMap.part_no ? String(row[columnMap.part_no] ?? '').trim() : '',
        });
      }

      const result = await replaceElectoralRoll(boothId, normalizedRows, fileName, officer);

      await broadcastToBooth(boothId, {
        type: 'roll:replaced',
        stats: result.stats,
        voters: result.voters,
        auditEntry: result.auditEntry,
      });
      await broadcastAdminUpdate();

      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Import failed.' });
    }
  })
);

app.post(
  '/api/booths/:boothId/close-poll',
  asyncRoute(requireAuth),
  asyncRoute(async (req, res) => {
    const { officer } = getAuthedOfficer(req);
    const boothId = String(req.params.boothId);
    if (officer.booth_id !== boothId) {
      res.status(403).json({ error: 'Access denied for this booth.' });
      return;
    }

    try {
      const result = await setBoothLock(boothId, true, officer);
      await broadcastToBooth(boothId, {
        type: 'booth:updated',
        booth: result.booth,
        auditEntry: result.auditEntry,
      });
      await broadcastAdminUpdate();
      res.json(result);
    } catch (err) {
      res.status(403).json({
        error: err instanceof Error ? err.message : 'Unable to close poll.',
      });
    }
  })
);

app.post(
  '/api/booths/:boothId/reopen-poll',
  asyncRoute(requireAuth),
  asyncRoute(async (req, res) => {
    const { officer } = getAuthedOfficer(req);
    const boothId = String(req.params.boothId);
    if (officer.booth_id !== boothId) {
      res.status(403).json({ error: 'Access denied for this booth.' });
      return;
    }

    try {
      const result = await setBoothLock(boothId, false, officer);
      await broadcastToBooth(boothId, {
        type: 'booth:updated',
        booth: result.booth,
        auditEntry: result.auditEntry,
      });
      await broadcastAdminUpdate();
      res.json(result);
    } catch (err) {
      res.status(403).json({
        error: err instanceof Error ? err.message : 'Unable to reopen poll.',
      });
    }
  })
);

app.get(
  '/api/booths/:boothId/report',
  asyncRoute(requireAuth),
  asyncRoute(async (req, res) => {
    const { officer } = getAuthedOfficer(req);
    const boothId = String(req.params.boothId);
    if (officer.booth_id !== boothId) {
      res.status(403).json({ error: 'Access denied for this booth.' });
      return;
    }
    const report = await generateEndOfDayReport(boothId);
    res.json(report);
  })
);

app.get(
  '/api/booths/:boothId/report/export',
  asyncRoute(requireAuth),
  asyncRoute(async (req, res) => {
    const { officer } = getAuthedOfficer(req);
    const boothId = String(req.params.boothId);
    if (officer.booth_id !== boothId) {
      res.status(403).json({ error: 'Access denied for this booth.' });
      return;
    }

    const format = String(req.query.format ?? 'xlsx').toLowerCase();
    const report = await generateEndOfDayReport(boothId);
    const state = await getBoothState(boothId);
    const voters = state?.voters ?? [];

    const summaryRows = [
      { Metric: 'Booth ID', Value: report.booth.id },
      { Metric: 'Booth Name', Value: report.booth.name },
      { Metric: 'Constituency', Value: report.booth.constituency },
      { Metric: 'Election', Value: report.booth.election_title },
      {
        Metric: 'Poll Status',
        Value: report.booth.is_locked ? 'Closed & Locked' : 'Open',
      },
      { Metric: 'Total Registered Voters', Value: report.stats.total_voters },
      { Metric: 'Votes Completed (Voted)', Value: report.stats.voted_count },
      { Metric: 'Marked Dead (Deceased)', Value: report.stats.dead_count },
      {
        Metric: 'Remaining Voters (Not Voted)',
        Value: report.stats.remaining_count,
      },
      {
        Metric: 'Turnout Percentage (%)',
        Value: `${report.stats.completion_percentage}%`,
      },
      {
        Metric: 'Duplicate Attempts Blocked',
        Value: report.stats.duplicate_attempts_blocked,
      },
      {
        Metric: 'Votes Reverted (Corrections)',
        Value: report.stats.reverted_count,
      },
      { Metric: 'Report Generated At', Value: report.generated_at },
    ];

    const voterRows = voters.map((v) => ({
      Serial_No: v.serial_no,
      Voter_ID: v.voter_id,
      Full_Name: v.full_name,
      Guardian_Name: v.guardian_name,
      Age: v.age ?? '',
      Gender: v.gender,
      Address: v.address,
      Status: v.status === 'VOTED' ? 'Voted' : v.status === 'DEAD' ? 'Dead' : 'Not Voted',
      Voted_At: v.voted_at ?? '',
      Verified_By: v.verified_by_officer_name ?? '',
      Marked_Dead_At: v.marked_dead_at ?? '',
      Marked_Dead_By: v.marked_dead_by_officer_name
        ? `${v.marked_dead_by_officer_name}${v.marked_dead_by_officer_role ? ` (${v.marked_dead_by_officer_role})` : ''}`
        : '',
      Dead_Remark: v.dead_note ?? '',
    }));

    const deadRows = report.dead_voters.map((v) => ({
      Serial_No: v.serial_no,
      Voter_ID: v.voter_id,
      Full_Name: v.full_name,
      Guardian_Name: v.guardian_name,
      Marked_Dead_By: v.marked_dead_by_officer_name ?? '',
      Officer_Role: v.marked_dead_by_officer_role ?? '',
      Marked_Dead_At: v.marked_dead_at ?? '',
      Remark: v.dead_note ?? '',
    }));

    if (format === 'csv') {
      const ws = XLSX.utils.json_to_sheet(voterRows);
      const csv = XLSX.utils.sheet_to_csv(ws);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${boothId}_end_of_day_report.csv"`
      );
      res.send(csv);
      return;
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(voterRows), 'Voter_Status_Roll');
    if (deadRows.length > 0) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(deadRows), 'Marked_Dead_Ledger');
    }
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(report.gender_breakdown),
      'Gender_Turnout'
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(report.hourly_turnout),
      'Hourly_Turnout'
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(report.audit_logs), 'Audit_Log');

    const buffer = XLSX.write(wb, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${boothId}_end_of_day_report.xlsx"`
    );
    res.send(buffer);
  })
);

// --- Ward Admin Routes ---

async function requireAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const admin = await getAdminByToken(token);
  if (!admin) {
    res.status(401).json({ error: 'Ward Admin authentication required.' });
    return;
  }
  (req as express.Request & { admin?: AdminUser; token?: string }).admin = admin;
  (req as express.Request & { admin?: AdminUser; token?: string }).token = token;
  next();
}

app.post(
  '/api/admin/login',
  asyncRoute(async (req, res) => {
    try {
      const { username, passcode } = req.body ?? {};
      const session = await loginAdmin(String(username ?? ''), String(passcode ?? ''));
      res.json(session);
    } catch (err) {
      res.status(401).json({
        error: err instanceof Error ? err.message : 'Admin login failed.',
      });
    }
  })
);

app.post(
  '/api/admin/logout',
  asyncRoute(requireAdmin),
  asyncRoute(async (req, res) => {
    const token = (req as express.Request & { token: string }).token;
    await logoutAdmin(token);
    res.json({ ok: true });
  })
);

app.get(
  '/api/admin/session',
  asyncRoute(requireAdmin),
  asyncRoute(async (req, res) => {
    const { admin, token } = req as express.Request & {
      admin: AdminUser;
      token: string;
    };
    res.json({ kind: 'admin', token, admin });
  })
);

app.get(
  '/api/admin/dashboard',
  asyncRoute(requireAdmin),
  asyncRoute(async (_req, res) => {
    res.json(await getAdminDashboardState(getOnlineOfficerMap()));
  })
);

app.get(
  '/api/admin/export',
  asyncRoute(requireAdmin),
  asyncRoute(async (req, res) => {
    const format = String(req.query.format ?? 'xlsx').toLowerCase();
    const dashboard = await getAdminDashboardState(getOnlineOfficerMap());

    const wardRows = dashboard.wards.map((w) => ({
      Ward_Constituency: w.constituency,
      Total_Booths: w.booth_count,
      Open_Booths: w.open_booths,
      Closed_Booths: w.closed_booths,
      Total_Registered_Voters: w.total_voters,
      Votes_Completed: w.voted_count,
      Marked_Dead: w.dead_count,
      Remaining_Voters: w.remaining_count,
      Turnout_Percentage: `${w.completion_percentage}%`,
      Duplicates_Blocked: w.duplicate_attempts_blocked,
    }));

    const boothRows = dashboard.booths.map((b) => ({
      Booth_ID: b.booth.id,
      Booth_Name: b.booth.name,
      Ward_Constituency: b.booth.constituency,
      Poll_Status: b.booth.is_locked ? 'Closed & Locked' : 'Open',
      Registered_Voters: b.stats.total_voters,
      Votes_Completed: b.stats.voted_count,
      Marked_Dead: b.stats.dead_count,
      Remaining_Voters: b.stats.remaining_count,
      Turnout_Percentage: `${b.stats.completion_percentage}%`,
      Duplicates_Blocked: b.stats.duplicate_attempts_blocked,
      Booth_Incharges: b.incharges
        .map(
          (i) =>
            `${i.full_name} (${i.role}, ${i.votes_verified} verified, ${i.dead_marked} marked dead, ${i.is_online ? 'Online' : i.is_logged_in ? 'Signed In' : 'Offline'})`
        )
        .join(' | '),
    }));

    if (format === 'csv') {
      const ws = XLSX.utils.json_to_sheet(boothRows);
      const csv = XLSX.utils.sheet_to_csv(ws);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="ward_booth_summary.csv"');
      res.send(csv);
      return;
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(wardRows), 'Ward_Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(boothRows), 'Booth_Wise_Stats');
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(dashboard.recent_audit_logs),
      'Ward_Audit_Feed'
    );

    const buffer = XLSX.write(wb, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="ward_booth_summary.xlsx"');
    res.send(buffer);
  })
);

// --- Frontend Serving (Vite dev middleware or production dist) ---

async function startServer(): Promise<void> {
  await initializeDatabase();
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error('Database request failed:', err instanceof Error ? err.name : 'Unknown error');
      res.status(500).json({ error: 'Unable to complete the request. Please try again.' });
    }
  );
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get(
        '*',
        asyncRoute(async (_req, res) => {
          res.sendFile(path.join(distDir, 'index.html'));
        })
      );
    }
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`BoothGuard server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(async (err) => {
  console.error(
    'Failed to start BoothGuard server:',
    err instanceof Error
      ? err.name + ': ' + err.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[redacted URI]')
      : 'Unknown error'
  );
  await closeDatabase();
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    wss.clients.forEach((ws) => ws.terminate());
    server.close(() => {
      void closeDatabase().finally(() => process.exit(0));
    });
  });
}
