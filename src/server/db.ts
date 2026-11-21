import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {
  connectDatabase,
  closeDatabase,
  transaction,
  find,
  one,
  count,
  update,
  insert,
  remove,
  nextId,
  lockBooth,
} from './mongo.ts';
import type {
  AdminUser,
  AdminDashboardState,
  AdminBoothItem,
  WardSummaryItem,
  BoothInchargeStat,
  AuditAction,
  AuditEntry,
  BoothSummary,
  BoothStats,
  BoothStatePayload,
  OfficerRole,
  OfficerPresence,
  VoterRecord,
  EndOfDayReport,
} from '../types/election.ts';
export { closeDatabase };
type Officer = {
  id: string;
  booth_id: string;
  username: string;
  full_name: string;
  role: OfficerRole;
  passcode: string;
  active_session_token: string | null;
  last_seen_at: string | null;
};
type Admin = AdminUser & {
  passcode: string;
  active_session_token: string | null;
};
const hashPasscode = (value: string) =>
  crypto.createHash('sha256').update(value.trim()).digest('hex');
const nowIso = () => new Date().toISOString();
const emptyStatus = {
  status: 'NOT_VOTED' as const,
  voted_at: null,
  verified_by_officer_id: null,
  verified_by_officer_name: null,
  marked_dead_at: null,
  marked_dead_by_officer_id: null,
  marked_dead_by_officer_name: null,
  marked_dead_by_officer_role: null,
  dead_note: null,
};

export async function initializeDatabase() {
  await connectDatabase();
  if (process.env.SEED_DEMO_DATA !== 'true') return;
  const demo = JSON.parse(await fs.readFile(new URL('./demo-data.json', import.meta.url), 'utf8'));
  await transaction(async () => {
    if ((await count('booths')) || (await count('admins'))) return;
    for (const name of ['booths', 'officers', 'voters', 'audit_logs', 'admins']) {
      for (const row of demo[name]) {
        if (name === 'booths') row.is_locked = Boolean(row.is_locked);
        if (name === 'voters' || name === 'audit_logs') row.id = await nextId(name);
        await insert(name, row);
      }
    }
  });
}
export async function getBoothSummary(boothId: string): Promise<BoothSummary | null> {
  const booth = await one<BoothSummary>('booths', { id: boothId });
  if (!booth) return null;
  return {
    ...booth,
    is_locked: Boolean(booth.is_locked),
    officer_count: await count('officers', { booth_id: boothId }),
    active_logins: await count('officers', {
      booth_id: boothId,
      active_session_token: { $ne: null },
    }),
  };
}
export async function listBooths(): Promise<BoothSummary[]> {
  const booths = await find<BoothSummary>('booths', {}, { created_at: -1 });
  const results: BoothSummary[] = [];
  for (const booth of booths) results.push((await getBoothSummary(booth.id))!);
  return results;
}
export async function createBoothWithOfficers(input: {
  id: string;
  name: string;
  constituency: string;
  electionTitle: string;
  officers: Array<{
    username: string;
    fullName: string;
    role: OfficerRole;
    passcode: string;
  }>;
}): Promise<{ booth: BoothSummary }> {
  return transaction(async () => {
    const id = input.id.trim().toUpperCase().replace(/\s+/g, '-');
    if (!id) throw new Error('Booth ID is required.');
    if (input.officers.length < 1 || input.officers.length > 2)
      throw new Error('Each booth must have 1 or 2 authorized officer logins.');
    if (await one('booths', { id })) throw new Error(`Booth ${id} already exists.`);
    await insert('booths', {
      id,
      name: input.name.trim(),
      constituency: input.constituency.trim() || 'General Constituency',
      election_title: input.electionTitle.trim() || 'Booth Election 2026',
      max_officers: 2,
      is_locked: false,
      closed_at: null,
      created_at: nowIso(),
    });
    for (const [idx, off] of input.officers.entries()) {
      await insert('officers', {
        id: `OFF-${id}-${idx + 1}`,
        booth_id: id,
        username: off.username.trim().toLowerCase(),
        full_name: off.fullName.trim(),
        role: off.role,
        passcode: hashPasscode(off.passcode),
        active_session_token: null,
        last_seen_at: null,
      });
    }
    return { booth: (await getBoothSummary(id))! };
  });
}
export async function insertAuditLog(
  boothId: string,
  action: AuditAction,
  voterId: string | null,
  serialNo: number | null,
  voterName: string | null,
  officerId: string | null,
  officerName: string | null,
  details: string
): Promise<AuditEntry> {
  const entry: AuditEntry = {
    id: await nextId('audit_logs'),
    booth_id: boothId,
    action,
    voter_id: voterId,
    serial_no: serialNo,
    voter_name: voterName,
    officer_id: officerId,
    officer_name: officerName,
    details,
    created_at: nowIso(),
  };
  await insert('audit_logs', entry);
  return entry;
}
export async function loginOfficer(
  boothId: string,
  username: string,
  passcode: string,
  _forceTakeover = false
) {
  return transaction(async () => {
    await lockBooth(boothId);
    const booth = await getBoothSummary(boothId);
    if (!booth) throw new Error('Selected booth was not found.');
    const officer = await one<Officer>('officers', {
      booth_id: boothId,
      username: username.trim().toLowerCase(),
    });
    if (!officer || officer.passcode !== hashPasscode(passcode))
      throw new Error('Invalid officer username or passcode.');
    if (
      (await count('officers', {
        booth_id: boothId,
        id: { $ne: officer.id },
        active_session_token: { $ne: null },
      })) >= booth.max_officers
    )
      throw new Error(
        `Booth ${boothId} already has the maximum of ${booth.max_officers} active officer logins.`
      );
    const token = crypto.randomBytes(24).toString('hex');
    await update(
      'officers',
      { id: officer.id },
      { active_session_token: token, last_seen_at: nowIso() }
    );
    await insertAuditLog(
      boothId,
      'OFFICER_LOGIN',
      null,
      null,
      null,
      officer.id,
      officer.full_name,
      `${officer.role} (${officer.username}) signed in to booth terminal`
    );
    return {
      token,
      booth: (await getBoothSummary(boothId))!,
      officer: {
        id: officer.id,
        username: officer.username,
        full_name: officer.full_name,
        role: officer.role,
      },
    };
  });
}
export async function getOfficerByToken(token: string) {
  if (!token) return null;
  const officer = await one<Officer>('officers', {
    active_session_token: token,
  });
  if (!officer) return null;
  await update(
    'officers',
    { id: officer.id, active_session_token: token },
    { last_seen_at: nowIso() }
  );
  const { id, booth_id, username, full_name, role } = officer;
  return { id, booth_id, username, full_name, role };
}
export async function logoutOfficer(token: string): Promise<string | null> {
  return transaction(async () => {
    const officer = await getOfficerByToken(token);
    if (!officer) return null;
    await lockBooth(officer.booth_id);
    await update(
      'officers',
      { id: officer.id, active_session_token: token },
      { active_session_token: null }
    );
    await insertAuditLog(
      officer.booth_id,
      'OFFICER_LOGOUT',
      null,
      null,
      null,
      officer.id,
      officer.full_name,
      `${officer.role} (${officer.username}) signed out`
    );
    return officer.booth_id;
  });
}
export async function getOfficersPresence(
  boothId: string,
  onlineOfficerIds = new Set<string>()
): Promise<OfficerPresence[]> {
  return (await find<Officer>('officers', { booth_id: boothId }, { id: 1 })).map((o) => ({
    id: o.id,
    booth_id: o.booth_id,
    username: o.username,
    full_name: o.full_name,
    role: o.role,
    is_logged_in: Boolean(o.active_session_token),
    is_online: onlineOfficerIds.has(o.id),
    last_seen_at: o.last_seen_at,
  }));
}
export async function getVoters(boothId: string): Promise<VoterRecord[]> {
  return find<VoterRecord>('voters', { booth_id: boothId }, { serial_no: 1 });
}
export async function getAuditLogs(boothId: string, limit = 100): Promise<AuditEntry[]> {
  return find<AuditEntry>('audit_logs', { booth_id: boothId }, { id: -1 }, limit);
}
export async function getBoothStats(boothId: string): Promise<BoothStats> {
  const total = await count('voters', { booth_id: boothId });
  const voted = await count('voters', { booth_id: boothId, status: 'VOTED' });
  const dead = await count('voters', { booth_id: boothId, status: 'DEAD' });
  const last = await find<VoterRecord>(
    'voters',
    { booth_id: boothId, status: 'VOTED' },
    { voted_at: -1 },
    1
  );
  return {
    total_voters: total,
    voted_count: voted,
    dead_count: dead,
    remaining_count: total - voted - dead,
    completion_percentage: total ? Number(((voted / total) * 100).toFixed(2)) : 0,
    duplicate_attempts_blocked: await count('audit_logs', {
      booth_id: boothId,
      action: { $in: ['DUPLICATE_BLOCKED', 'DEAD_VOTER_BLOCKED'] },
    }),
    reverted_count: await count('audit_logs', {
      booth_id: boothId,
      action: 'REVERT_VOTE',
    }),
    last_vote_at: last[0]?.voted_at ?? null,
  };
}
export async function getBoothState(
  boothId: string,
  onlineOfficerIds = new Set<string>()
): Promise<BoothStatePayload | null> {
  const booth = await getBoothSummary(boothId);
  if (!booth) return null;
  return {
    booth,
    officers: await getOfficersPresence(boothId, onlineOfficerIds),
    voters: await getVoters(boothId),
    stats: await getBoothStats(boothId),
    audit_logs: await getAuditLogs(boothId, 120),
  };
}

type VoteResult =
  | { ok: true; voter: VoterRecord; stats: BoothStats; auditEntry: AuditEntry }
  | {
      ok: false;
      code: 'LOCKED' | 'NOT_FOUND' | 'ALREADY_VOTED' | 'MARKED_DEAD' | 'ALREADY_DEAD';
      voter?: VoterRecord;
      stats?: BoothStats;
      auditEntry?: AuditEntry;
    };
async function changeStatus(
  boothId: string,
  voterRecordId: number,
  status: 'VOTED' | 'DEAD',
  note: string,
  officer: { id: string; full_name: string; role?: OfficerRole }
): Promise<VoteResult> {
  return transaction(async () => {
    await lockBooth(boothId);
    const booth = await getBoothSummary(boothId);
    if (!booth) return { ok: false, code: 'NOT_FOUND' };
    if (booth.is_locked) return { ok: false, code: 'LOCKED' };
    const filter = { booth_id: boothId, id: voterRecordId };
    const voter = await one<VoterRecord>('voters', filter);
    if (!voter) return { ok: false, code: 'NOT_FOUND' };
    if (voter.status !== 'NOT_VOTED') {
      if (status === 'DEAD')
        return {
          ok: false,
          code: voter.status === 'DEAD' ? 'ALREADY_DEAD' : 'ALREADY_VOTED',
          voter,
        };
      const auditEntry = await insertAuditLog(
        boothId,
        voter.status === 'DEAD' ? 'DEAD_VOTER_BLOCKED' : 'DUPLICATE_BLOCKED',
        voter.voter_id,
        voter.serial_no,
        voter.full_name,
        officer.id,
        officer.full_name,
        `Blocked vote attempt: voter is already ${voter.status}.`
      );
      return {
        ok: false,
        code: voter.status === 'DEAD' ? 'MARKED_DEAD' : 'ALREADY_VOTED',
        voter,
        auditEntry,
        stats: await getBoothStats(boothId),
      };
    }
    const fields =
      status === 'VOTED'
        ? {
            status,
            voted_at: nowIso(),
            verified_by_officer_id: officer.id,
            verified_by_officer_name: officer.full_name,
          }
        : {
            status,
            marked_dead_at: nowIso(),
            marked_dead_by_officer_id: officer.id,
            marked_dead_by_officer_name: officer.full_name,
            marked_dead_by_officer_role: officer.role,
            dead_note: note.trim() || null,
          };
    await update('voters', { ...filter, status: 'NOT_VOTED' }, fields);
    const updated = (await one<VoterRecord>('voters', filter))!;
    const auditEntry = await insertAuditLog(
      boothId,
      status === 'VOTED' ? 'MARK_VOTED' : 'MARK_DEAD',
      voter.voter_id,
      voter.serial_no,
      voter.full_name,
      officer.id,
      officer.full_name,
      `Marked Serial #${voter.serial_no} (${voter.voter_id}) as ${status}${note.trim() ? `. Note: ${note.trim()}` : ''}`
    );
    return {
      ok: true,
      voter: updated,
      stats: await getBoothStats(boothId),
      auditEntry,
    };
  });
}
export async function markVoterAsVoted(
  boothId: string,
  voterRecordId: number,
  officer: { id: string; full_name: string }
) {
  return changeStatus(boothId, voterRecordId, 'VOTED', '', officer);
}
export async function markVoterAsDead(
  boothId: string,
  voterRecordId: number,
  note: string,
  officer: { id: string; full_name: string; role: OfficerRole }
) {
  return changeStatus(boothId, voterRecordId, 'DEAD', note, officer);
}
export async function revertVoterStatus(
  boothId: string,
  voterRecordId: number,
  reason: string,
  officer: { id: string; full_name: string; role: OfficerRole }
) {
  return transaction(async () => {
    await lockBooth(boothId);
    const booth = await getBoothSummary(boothId);
    if (!booth) throw new Error('Booth not found.');
    if (booth.is_locked)
      throw new Error('Poll is closed for the day. Reopen poll to make corrections.');
    if (officer.role !== 'Presiding Officer')
      throw new Error('Only a Presiding Officer can revert a recorded voter status.');
    if (reason.trim().length < 4)
      throw new Error(
        'A clear correction reason (at least 4 characters) is required for the audit trail.'
      );
    const filter = { booth_id: boothId, id: voterRecordId };
    const existing = await one<VoterRecord>('voters', filter);
    if (!existing) throw new Error('Voter record not found.');
    if (existing.status === 'NOT_VOTED') throw new Error('Voter is already marked as Not Voted.');
    await update('voters', filter, emptyStatus);
    const auditEntry = await insertAuditLog(
      boothId,
      'REVERT_VOTE',
      existing.voter_id,
      existing.serial_no,
      existing.full_name,
      officer.id,
      officer.full_name,
      `Reverted Serial #${existing.serial_no} (${existing.voter_id}) from ${existing.status} to NOT VOTED. Reason: ${reason.trim()}`
    );
    return {
      voter: (await one<VoterRecord>('voters', filter))!,
      stats: await getBoothStats(boothId),
      auditEntry,
    };
  });
}
export async function replaceElectoralRoll(
  boothId: string,
  rows: Array<
    Pick<
      VoterRecord,
      | 'serial_no'
      | 'voter_id'
      | 'full_name'
      | 'guardian_name'
      | 'age'
      | 'gender'
      | 'address'
      | 'part_no'
    > & { initial_voted?: boolean }
  >,
  fileName: string,
  officer: { id: string; full_name: string }
) {
  return transaction(async () => {
    await lockBooth(boothId);
    const booth = await getBoothSummary(boothId);
    if (!booth) throw new Error('Booth not found.');
    if (booth.is_locked) throw new Error('Cannot replace voter roll while poll is closed.');
    if (!rows.length) throw new Error('No valid voter rows found in uploaded spreadsheet.');
    await remove('voters', { booth_id: boothId });
    for (const { initial_voted, ...row } of rows) {
      await insert('voters', {
        ...row,
        ...emptyStatus,
        id: await nextId('voters'),
        booth_id: boothId,
        ...(initial_voted
          ? {
              status: 'VOTED',
              voted_at: nowIso(),
              verified_by_officer_id: officer.id,
              verified_by_officer_name: officer.full_name,
            }
          : {}),
      });
    }
    const auditEntry = await insertAuditLog(
      boothId,
      'ROLL_UPLOADED',
      null,
      null,
      null,
      officer.id,
      officer.full_name,
      `Imported ${rows.length} voters from ${fileName}`
    );
    return {
      voters: await getVoters(boothId),
      stats: await getBoothStats(boothId),
      auditEntry,
    };
  });
}
export async function setBoothLock(
  boothId: string,
  locked: boolean,
  officer: { id: string; full_name: string; role: OfficerRole }
) {
  return transaction(async () => {
    if (officer.role !== 'Presiding Officer')
      throw new Error('Only a Presiding Officer can close or reopen the booth poll.');
    await lockBooth(boothId);
    if (!(await getBoothSummary(boothId))) throw new Error('Booth not found.');
    await update(
      'booths',
      { id: boothId },
      { is_locked: locked, closed_at: locked ? nowIso() : null }
    );
    const auditEntry = await insertAuditLog(
      boothId,
      locked ? 'POLL_CLOSED' : 'POLL_REOPENED',
      null,
      null,
      null,
      officer.id,
      officer.full_name,
      locked
        ? 'Presiding Officer closed the booth poll.'
        : 'Presiding Officer reopened the booth poll.'
    );
    return { booth: (await getBoothSummary(boothId))!, auditEntry };
  });
}
export async function loginAdmin(
  username: string,
  passcode: string
): Promise<{ kind: 'admin'; token: string; admin: AdminUser }> {
  const row = await one<Admin>('admins', {
    username: username.trim().toLowerCase(),
  });
  if (!row || row.passcode !== hashPasscode(passcode))
    throw new Error('Invalid admin username or passcode.');
  const token = crypto.randomBytes(24).toString('hex');
  await update('admins', { id: row.id }, { active_session_token: token, last_seen_at: nowIso() });
  const { id, full_name, title } = row;
  return {
    kind: 'admin',
    token,
    admin: { id, username: row.username, full_name, title },
  };
}
export async function getAdminByToken(token: string): Promise<AdminUser | null> {
  if (!token) return null;
  const row = await one<Admin>('admins', { active_session_token: token });
  if (!row) return null;
  await update('admins', { id: row.id, active_session_token: token }, { last_seen_at: nowIso() });
  const { id, username, full_name, title } = row;
  return { id, username, full_name, title };
}
export async function logoutAdmin(token: string): Promise<boolean> {
  if (!token) return false;
  return (
    (await update('admins', { active_session_token: token }, { active_session_token: null }))
      .modifiedCount > 0
  );
}

export async function generateEndOfDayReport(boothId: string): Promise<EndOfDayReport> {
  const booth = await getBoothSummary(boothId);
  if (!booth) {
    throw new Error('Booth not found.');
  }

  const voters = await getVoters(boothId);
  const stats = await getBoothStats(boothId);
  const auditLogs = await getAuditLogs(boothId, 250);

  // Gender breakdown
  const genderMap = new Map<string, { total: number; voted: number }>();
  for (const v of voters) {
    const g = v.gender?.trim() || 'Other';
    const curr = genderMap.get(g) ?? { total: 0, voted: 0 };
    curr.total += 1;
    if (v.status === 'VOTED') curr.voted += 1;
    genderMap.set(g, curr);
  }
  const gender_breakdown = Array.from(genderMap.entries()).map(([gender, d]) => ({
    gender,
    total: d.total,
    voted: d.voted,
    remaining: d.total - d.voted,
    percentage: d.total > 0 ? Number(((d.voted / d.total) * 100).toFixed(1)) : 0,
  }));

  // Age bracket breakdown
  const ageBuckets: Array<{ label: string; min: number; max: number }> = [
    { label: '18–25', min: 18, max: 25 },
    { label: '26–40', min: 26, max: 40 },
    { label: '41–60', min: 41, max: 60 },
    { label: '61+', min: 61, max: 150 },
  ];
  const age_breakdown = ageBuckets.map((b) => {
    const matching = voters.filter((v) => v.age !== null && v.age >= b.min && v.age <= b.max);
    const voted = matching.filter((v) => v.status === 'VOTED').length;
    return {
      bracket: b.label,
      total: matching.length,
      voted,
      percentage: matching.length > 0 ? Number(((voted / matching.length) * 100).toFixed(1)) : 0,
    };
  });

  // Hourly turnout velocity
  const hourMap = new Map<string, number>();
  for (const v of voters) {
    if (v.status === 'VOTED' && v.voted_at) {
      const dt = new Date(v.voted_at);
      const hr = `${String(dt.getHours()).padStart(2, '0')}:00`;
      hourMap.set(hr, (hourMap.get(hr) ?? 0) + 1);
    }
  }
  const sortedHours = Array.from(hourMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  let cumulative = 0;
  const hourly_turnout = sortedHours.map(([hour, count]) => {
    cumulative += count;
    return { hour, count, cumulative };
  });

  // Officer activity summary
  const officers = await getOfficersPresence(boothId);
  const officer_activity = officers.map((o) => {
    const votes_verified = voters.filter(
      (v) => v.status === 'VOTED' && v.verified_by_officer_id === o.id
    ).length;
    const dead_marked = voters.filter(
      (v) => v.status === 'DEAD' && v.marked_dead_by_officer_id === o.id
    ).length;
    const duplicates_blocked = auditLogs.filter(
      (a) =>
        (a.action === 'DUPLICATE_BLOCKED' || a.action === 'DEAD_VOTER_BLOCKED') &&
        a.officer_id === o.id
    ).length;
    return {
      officer_id: o.id,
      officer_name: o.full_name,
      role: o.role,
      votes_verified,
      dead_marked,
      duplicates_blocked,
    };
  });

  const dead_voters = voters.filter((v) => v.status === 'DEAD');

  return {
    generated_at: nowIso(),
    booth,
    stats,
    gender_breakdown,
    age_breakdown,
    hourly_turnout,
    officer_activity,
    dead_voters,
    audit_logs: auditLogs,
  };
}

export async function getAdminDashboardState(
  onlineOfficerIdsByBooth: Map<string, Set<string>> = new Map()
): Promise<AdminDashboardState> {
  const allBooths = await listBooths();
  const boothItems: AdminBoothItem[] = [];
  const wardMap = new Map<string, WardSummaryItem>();

  let overallTotalVoters = 0;
  let overallVotedCount = 0;
  let overallDeadCount = 0;
  let overallRemainingCount = 0;
  let overallDuplicates = 0;
  let overallOpenBooths = 0;
  let overallClosedBooths = 0;
  let overallOnlineIncharges = 0;
  let overallTotalIncharges = 0;

  for (const booth of allBooths) {
    const stats = await getBoothStats(booth.id);
    const onlineSet = onlineOfficerIdsByBooth.get(booth.id) ?? new Set<string>();
    const officers = await getOfficersPresence(booth.id, onlineSet);

    const voters = await getVoters(booth.id);
    const auditLogs = await getAuditLogs(booth.id, 0);
    const votesByOfficer = new Map(
      officers.map((o) => [
        o.id,
        voters.filter((v) => v.status === 'VOTED' && v.verified_by_officer_id === o.id).length,
      ])
    );
    const deadByOfficer = new Map(
      officers.map((o) => [
        o.id,
        voters.filter((v) => v.status === 'DEAD' && v.marked_dead_by_officer_id === o.id).length,
      ])
    );
    const dupsByOfficer = new Map(
      officers.map((o) => [
        o.id,
        auditLogs.filter(
          (a) =>
            ['DUPLICATE_BLOCKED', 'DEAD_VOTER_BLOCKED'].includes(a.action) && a.officer_id === o.id
        ).length,
      ])
    );
    const incharges: BoothInchargeStat[] = officers.map((o) => ({
      ...o,
      votes_verified: votesByOfficer.get(o.id) ?? 0,
      dead_marked: deadByOfficer.get(o.id) ?? 0,
      duplicates_blocked: dupsByOfficer.get(o.id) ?? 0,
    }));

    boothItems.push({ booth, stats, incharges });

    overallTotalVoters += stats.total_voters;
    overallVotedCount += stats.voted_count;
    overallDeadCount += stats.dead_count;
    overallRemainingCount += stats.remaining_count;
    overallDuplicates += stats.duplicate_attempts_blocked;
    if (booth.is_locked) {
      overallClosedBooths += 1;
    } else {
      overallOpenBooths += 1;
    }
    overallTotalIncharges += incharges.length;
    overallOnlineIncharges += incharges.filter((i) => i.is_online || i.is_logged_in).length;

    const wardKey = booth.constituency || 'General Ward';
    const existingWard = wardMap.get(wardKey) ?? {
      constituency: wardKey,
      booth_count: 0,
      open_booths: 0,
      closed_booths: 0,
      total_voters: 0,
      voted_count: 0,
      dead_count: 0,
      remaining_count: 0,
      completion_percentage: 0,
      duplicate_attempts_blocked: 0,
    };

    existingWard.booth_count += 1;
    if (booth.is_locked) existingWard.closed_booths += 1;
    else existingWard.open_booths += 1;
    existingWard.total_voters += stats.total_voters;
    existingWard.voted_count += stats.voted_count;
    existingWard.dead_count += stats.dead_count;
    existingWard.remaining_count += stats.remaining_count;
    existingWard.duplicate_attempts_blocked += stats.duplicate_attempts_blocked;
    existingWard.completion_percentage =
      existingWard.total_voters > 0
        ? Number(((existingWard.voted_count / existingWard.total_voters) * 100).toFixed(2))
        : 0;
    wardMap.set(wardKey, existingWard);
  }

  const recentAuditRows = (await find<AuditEntry>('audit_logs', {}, { id: -1 }, 60)).map((a) => ({
    ...a,
    booth_name: allBooths.find((b) => b.id === a.booth_id)?.name ?? '',
  }));
  const overallPct =
    overallTotalVoters > 0
      ? Number(((overallVotedCount / overallTotalVoters) * 100).toFixed(2))
      : 0;

  return {
    generated_at: nowIso(),
    overall: {
      total_booths: allBooths.length,
      open_booths: overallOpenBooths,
      closed_booths: overallClosedBooths,
      total_voters: overallTotalVoters,
      voted_count: overallVotedCount,
      dead_count: overallDeadCount,
      remaining_count: overallRemainingCount,
      completion_percentage: overallPct,
      duplicate_attempts_blocked: overallDuplicates,
      online_incharges: overallOnlineIncharges,
      total_incharges: overallTotalIncharges,
    },
    wards: Array.from(wardMap.values()),
    booths: boothItems,
    recent_audit_logs: recentAuditRows,
  };
}
