import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Never run destructive test cleanup against the configured application database.
const testDbName = `bgtest_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
process.env.MONGODB_DB_NAME = testDbName;
process.env.SEED_DEMO_DATA = 'false';
const db = await import('../src/server/db.ts');
const { client } = await import('../src/server/mongo.ts');
try {
  await db.initializeDatabase();
  const boothId = 'TEST-001';
  await db.createBoothWithOfficers({
    id: boothId,
    name: 'Test booth',
    constituency: 'Test ward',
    electionTitle: 'Test election',
    officers: [
      {
        username: 'presiding',
        fullName: 'Test Presiding',
        role: 'Presiding Officer',
        passcode: '1001',
      },
      {
        username: 'polling',
        fullName: 'Test Polling',
        role: 'Polling Officer',
        passcode: '1002',
      },
    ],
  });
  await assert.rejects(
    db.createBoothWithOfficers({
      id: 'ROLLBACK',
      name: 'Rollback',
      constituency: 'Test',
      electionTitle: 'Test',
      officers: [
        {
          username: 'same',
          fullName: 'One',
          role: 'Presiding Officer',
          passcode: '1001',
        },
        {
          username: 'same',
          fullName: 'Two',
          role: 'Polling Officer',
          passcode: '1002',
        },
      ],
    })
  );
  assert.equal(await db.getBoothSummary('ROLLBACK'), null);
  await assert.rejects(db.loginOfficer(boothId, 'presiding', 'wrong'));
  const session = await db.loginOfficer(boothId, 'PRESIDING', '1001');
  const officer = (await db.getOfficerByToken(session.token))!;
  assert.equal(officer.role, 'Presiding Officer');
  assert.equal('passcode' in officer, false);
  const polling = await db.loginOfficer(boothId, 'polling', '1002');
  const rows = [1, 2].map((i) => ({
    serial_no: i,
    voter_id: `TEST${i}`,
    full_name: `Voter ${i}`,
    guardian_name: 'Guardian',
    age: 30,
    gender: 'Other',
    address: 'Test',
    part_no: '1',
  }));
  const roll = await db.replaceElectoralRoll(boothId, rows, 'test.csv', officer);
  const id = roll.voters[0].id;
  const results = await Promise.all([
    db.markVoterAsVoted(boothId, id, officer),
    db.markVoterAsVoted(boothId, id, polling.officer),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok && r.code === 'ALREADY_VOTED').length, 1);
  assert.equal((await db.getBoothStats(boothId)).duplicate_attempts_blocked, 1);
  await assert.rejects(
    db.revertVoterStatus(boothId, id, 'Correction', {
      ...polling.officer,
      role: 'Polling Officer',
    })
  );
  await db.revertVoterStatus(boothId, id, 'Test correction', officer);
  assert.equal((await db.markVoterAsDead(boothId, id, 'Test note', officer)).ok, true);
  const blocked = await db.markVoterAsVoted(boothId, id, officer);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, 'MARKED_DEAD');
  await db.setBoothLock(boothId, true, officer);
  const locked = await db.markVoterAsVoted(boothId, roll.voters[1].id, officer);
  if (!locked.ok) assert.equal(locked.code, 'LOCKED');
  else assert.fail('Vote accepted while locked');
  await assert.rejects(db.replaceElectoralRoll(boothId, rows, 'test.csv', officer));
  await db.setBoothLock(boothId, false, officer);
  await assert.rejects(
    db.replaceElectoralRoll(boothId, [rows[0], rows[0]], 'duplicates.csv', officer)
  );
  assert.equal((await db.getVoters(boothId))[0].status, 'DEAD');
  assert.equal((await db.getVoters(boothId)).length, 2);
  const report = await db.generateEndOfDayReport(boothId);
  assert.equal(report.dead_voters.length, 1);
  assert.equal(report.stats.duplicate_attempts_blocked, 2);
  assert.equal((await db.getAdminDashboardState()).overall.total_voters, 2);
  await db.closeDatabase();
  await db.initializeDatabase();
  assert.equal((await db.getVoters(boothId))[0].status, 'DEAD');
  await db.logoutOfficer(session.token);
  assert.equal(await db.getOfficerByToken(session.token), null);
  console.log(
    'PASS: booth creation rollback, authentication, concurrent duplicate prevention, deceased-voter blocking, corrections, poll locking, import rollback, reporting, persistence, logout.'
  );
} finally {
  assert.match(testDbName, /^bgtest_[a-f0-9]{24}$/);
  await client.db(testDbName).dropDatabase();
  await db.closeDatabase();
}
