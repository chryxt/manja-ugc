const { Pool } = require('pg');
const assert = require('assert/strict');

const requestPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 16,
});

const verifierPool = new Pool({
  connectionString: process.env.DB_TEST_ADMIN_URL || process.env.DATABASE_URL,
  max: 8,
});

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

async function tx(client, fn) {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '15s'`);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

async function concurrentCall(fnA, fnB) {
  const a = await requestPool.connect();
  const b = await requestPool.connect();
  try {
    return await Promise.allSettled([
      tx(a, () => fnA(a)),
      tx(b, () => fnB(b)),
    ]);
  } finally {
    a.release();
    b.release();
  }
}

async function createFixture({ suffix, balance = 1000, jobState = 'processing' }) {
  const c = await verifierPool.connect();
  try {
    await c.query('BEGIN');

    const actor = await c.query(`
      INSERT INTO auth.users (id, email, role)
      VALUES (gen_random_uuid(), $1, 'authenticated')
      RETURNING id
    `, [`ugc-job-test-${suffix}@test.local`]);
    const actorId = actor.rows[0].id;

    const ws = await c.query(`
      INSERT INTO public.workspaces (id, name, slug)
      VALUES (gen_random_uuid(), $1, $2)
      RETURNING id
    `, ['UGC Job Race Test', `ugc-job-race-${suffix}`]);
    const workspaceId = ws.rows[0].id;

    await c.query(`
      INSERT INTO public.workspace_members (workspace_id, user_id, role)
      VALUES ($1, $2, 'owner')
    `, [workspaceId, actorId]);

    await c.query(`
      INSERT INTO public.credit_accounts (workspace_id, balance, reserved_credits)
      VALUES ($1, $2, 0)
    `, [workspaceId, balance]);

    const created = await c.query(`
      SELECT private.create_job_and_reserve_credits(
        $1, 'ugc_video', $2, $3
      ) AS job_id
    `, [workspaceId, actorId, `initial-${suffix}`]);
    const jobId = created.rows[0].job_id;

    if (jobState !== 'queued') {
      await c.query(`
        SELECT private.transition_job_state($1, 'processing', 'test-processing')
      `, [jobId]);

      if (jobState === 'rendering') {
        await c.query(`
          SELECT private.transition_job_state($1, 'rendering', 'test-rendering')
        `, [jobId]);
      }
    }

    const op = await c.query(`
      SELECT private.start_job_operation(
        $1, 'gemini', 'scene_01', 'video_generation', '{"fixture":true}'::jsonb
      ) AS operation_id
    `, [jobId]);
    const operationId = op.rows[0].operation_id;

    await c.query('COMMIT');
    return { workspaceId, actorId, jobId, operationId };
  } catch (err) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    c.release();
  }
}

async function failJob(f, code = 'TEST_FAIL') {
  const c = await requestPool.connect();
  try {
    await tx(c, () => c.query(`
      SELECT private.finalize_job($1, 'failed', $2, $3, 'test failure')
    `, [f.jobId, f.actorId, code]));
  } finally {
    c.release();
  }
}

async function verifyJob(jobId) {
  const c = await verifierPool.connect();
  try {
    const r = await c.query(`
      SELECT
        j.id,
        j.workspace_id,
        j.status::text AS status,
        j.parent_job_id,
        j.root_job_id,
        j.attempt_number,
        j.cost_snapshot,
        ca.balance,
        ca.reserved_credits,
        cr.id AS reservation_id,
        cr.status::text AS reservation_status,
        cr.amount AS reservation_amount,
        cr.finalized_at,
        (
          SELECT count(*)::int
          FROM public.credit_transactions ct
          WHERE ct.job_id = j.id
            AND ct.transaction_type = 'JOB_DEDUCT'
        ) AS deduct_count,
        (
          SELECT count(*)::int
          FROM public.audit_logs al
          WHERE al.target_id = j.id
            AND al.action IN ('JOB_COMPLETED','JOB_FAILED','JOB_CANCELLED')
        ) AS terminal_audit_count
      FROM public.jobs j
      JOIN public.credit_accounts ca
        ON ca.workspace_id = j.workspace_id
      JOIN public.credit_reservations cr
        ON cr.job_id = j.id
       AND cr.workspace_id = j.workspace_id
      WHERE j.id = $1
    `, [jobId]);

    assert.equal(r.rowCount, 1, `Expected one job aggregate for ${jobId}`);
    return r.rows[0];
  } finally {
    c.release();
  }
}

async function verifyOperation(operationId) {
  const c = await verifierPool.connect();
  try {
    const r = await c.query(`
      SELECT id, job_id, status::text AS status, provider_operation_id, completed_at
      FROM public.job_operations
      WHERE id = $1
    `, [operationId]);

    assert.equal(r.rowCount, 1, 'Expected one operation');
    return r.rows[0];
  } finally {
    c.release();
  }
}

async function countRetryChildren(parentJobId) {
  const c = await verifierPool.connect();
  try {
    const r = await c.query(`
      SELECT count(*)::int AS count
      FROM public.jobs
      WHERE parent_job_id = $1
    `, [parentJobId]);
    return r.rows[0].count;
  } finally {
    c.release();
  }
}

async function c01() {
  const f = await createFixture({ suffix: `c01-${Date.now()}`, jobState: 'processing' });
  const providerId = `gemini-c01-${Date.now()}`;

  const results = await concurrentCall(
    c => c.query(`
      SELECT private.finalize_job_operation(
        $1,$2,'succeeded',$3,'{"caller":"A"}'::jsonb,NULL,NULL
      )
    `, [f.jobId, f.operationId, providerId]),
    c => c.query(`
      SELECT private.finalize_job_operation(
        $1,$2,'succeeded',$3,'{"caller":"B"}'::jsonb,NULL,NULL
      )
    `, [f.jobId, f.operationId, providerId]),
  );

  assert.equal(results.filter(x => x.status === 'fulfilled').length, 2);
  const op = await verifyOperation(f.operationId);
  assert.equal(op.status, 'succeeded');
  assert.equal(op.provider_operation_id, providerId);
  return 'C01 double callback same outcome';
}

async function c02() {
  const f = await createFixture({ suffix: `c02-${Date.now()}`, jobState: 'processing' });

  const results = await concurrentCall(
    c => c.query(`
      SELECT private.finalize_job_operation($1,$2,'succeeded',$3,NULL,NULL,NULL)
    `, [f.jobId, f.operationId, `gemini-A-${Date.now()}`]),
    c => c.query(`
      SELECT private.finalize_job_operation($1,$2,'succeeded',$3,NULL,NULL,NULL)
    `, [f.jobId, f.operationId, `gemini-B-${Date.now()}`]),
  );

  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  return 'C02 provider operation identity conflict';
}

async function c03() {
  const f = await createFixture({ suffix: `c03-${Date.now()}`, jobState: 'rendering' });
  const before = await verifyJob(f.jobId);
  const balance = Number(before.balance);
  const cost = Number(before.cost_snapshot);

  const results = await concurrentCall(
    c => c.query(`SELECT private.finalize_job($1,'completed',$2,NULL,NULL)`, [f.jobId, f.actorId]),
    c => c.query(`SELECT private.finalize_job($1,'completed',$2,NULL,NULL)`, [f.jobId, f.actorId]),
  );

  assert.equal(results.filter(x => x.status === 'fulfilled').length, 2);

  const after = await verifyJob(f.jobId);
  assert.equal(after.status, 'completed');
  assert.equal(after.reservation_status, 'SETTLED');
  assert.equal(Number(after.balance), balance - cost);
  assert.equal(Number(after.reserved_credits), 0);
  assert.equal(Number(after.deduct_count), 1);
  assert.equal(Number(after.terminal_audit_count), 1);
  return 'C03 double settlement';
}

async function c04() {
  const f = await createFixture({ suffix: `c04-${Date.now()}`, jobState: 'rendering' });
  const before = await verifyJob(f.jobId);
  const balance = Number(before.balance);
  const cost = Number(before.cost_snapshot);

  const results = await concurrentCall(
    c => c.query(`SELECT private.finalize_job($1,'completed',$2,NULL,NULL)`, [f.jobId, f.actorId]),
    c => c.query(`
      SELECT private.finalize_job($1,'failed',$2,'PROVIDER_FAIL','race test')
    `, [f.jobId, f.actorId]),
  );

  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);

  const after = await verifyJob(f.jobId);
  assert.equal(Number(after.reserved_credits), 0);
  assert.equal(Number(after.terminal_audit_count), 1);

  if (after.status === 'completed') {
    assert.equal(after.reservation_status, 'SETTLED');
    assert.equal(Number(after.balance), balance - cost);
    assert.equal(Number(after.deduct_count), 1);
  } else {
    assert.equal(after.status, 'failed');
    assert.equal(after.reservation_status, 'RELEASED');
    assert.equal(Number(after.balance), balance);
    assert.equal(Number(after.deduct_count), 0);
  }

  return 'C04 completed vs failed race';
}

async function c05() {
  const f = await createFixture({ suffix: `c05-${Date.now()}`, jobState: 'processing' });
  await failJob(f, 'C05_FAIL');
  const key = `retry-c05-${Date.now()}`;

  const results = await concurrentCall(
    c => c.query(`SELECT private.retry_job($1,$2,$3) AS job_id`, [f.jobId, f.actorId, key]),
    c => c.query(`SELECT private.retry_job($1,$2,$3) AS job_id`, [f.jobId, f.actorId, key]),
  );

  assert.equal(results.filter(x => x.status === 'fulfilled').length, 2);
  const ids = results.map(x => x.value.rows[0].job_id);
  assert.equal(ids[0], ids[1]);
  assert.equal(await countRetryChildren(f.jobId), 1);

  const source = await verifyJob(f.jobId);
  const child = await verifyJob(ids[0]);
  assert.equal(source.reservation_status, 'RELEASED');
  assert.equal(child.reservation_status, 'RESERVED');
  return 'C05 same source + same retry idempotency key';
}

async function c06() {
  const f = await createFixture({ suffix: `c06-${Date.now()}`, jobState: 'processing' });
  await failJob(f, 'C06_FAIL');

  const results = await concurrentCall(
    c => c.query(`SELECT private.retry_job($1,$2,$3) AS job_id`, [
      f.jobId, f.actorId, `retry-c06-A-${Date.now()}`
    ]),
    c => c.query(`SELECT private.retry_job($1,$2,$3) AS job_id`, [
      f.jobId, f.actorId, `retry-c06-B-${Date.now()}`
    ]),
  );

  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.equal(await countRetryChildren(f.jobId), 1);
  return 'C06 same source + different retry idempotency keys';
}

async function c07() {
  const f = await createFixture({ suffix: `c07-${Date.now()}`, balance: 1000, jobState: 'processing' });
  await failJob(f, 'C07_FAIL');

  const source = await verifyJob(f.jobId);
  const cost = Number(source.cost_snapshot);

  const admin = await verifierPool.connect();
  try {
    await admin.query(`
      UPDATE public.credit_accounts
      SET balance = $2, reserved_credits = 0
      WHERE workspace_id = $1
    `, [f.workspaceId, cost]);
  } finally {
    admin.release();
  }

  const results = await concurrentCall(
    c => c.query(`SELECT private.retry_job($1,$2,$3) AS job_id`, [
      f.jobId, f.actorId, `retry-c07-${Date.now()}`
    ]),
    c => c.query(`
      SELECT private.create_job_and_reserve_credits($1,'ugc_video',$2,$3) AS job_id
    `, [f.workspaceId, f.actorId, `fresh-c07-${Date.now()}`]),
  );

  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);

  const c = await verifierPool.connect();
  try {
    const acc = await c.query(`
      SELECT balance, reserved_credits
      FROM public.credit_accounts
      WHERE workspace_id = $1
    `, [f.workspaceId]);

    assert.equal(Number(acc.rows[0].balance), cost);
    assert.equal(Number(acc.rows[0].reserved_credits), cost);
    assert.ok(Number(acc.rows[0].reserved_credits) <= Number(acc.rows[0].balance));

    const reservations = await c.query(`
      SELECT count(*)::int AS count
      FROM public.credit_reservations
      WHERE workspace_id = $1 AND status = 'RESERVED'
    `, [f.workspaceId]);

    assert.equal(reservations.rows[0].count, 1);
  } finally {
    c.release();
  }

  return 'C07 concurrent retry vs credit consumption';
}

async function c08() {
  const f = await createFixture({ suffix: `c08-${Date.now()}`, jobState: 'processing' });
  await failJob(f, 'C08_ROOT_FAIL');

  const c = await requestPool.connect();
  let childId;
  let grandchildId;

  try {
    const child = await tx(c, () => c.query(`
      SELECT private.retry_job($1,$2,$3) AS job_id
    `, [f.jobId, f.actorId, `retry-c08-child-${Date.now()}`]));
    childId = child.rows[0].job_id;

    await tx(c, () => c.query(`
      SELECT private.transition_job_state($1,'processing','retry-child-processing')
    `, [childId]));

    await tx(c, () => c.query(`
      SELECT private.finalize_job($1,'failed',$2,'C08_CHILD_FAIL','lineage test')
    `, [childId, f.actorId]));

    const grandchild = await tx(c, () => c.query(`
      SELECT private.retry_job($1,$2,$3) AS job_id
    `, [childId, f.actorId, `retry-c08-grandchild-${Date.now()}`]));
    grandchildId = grandchild.rows[0].job_id;
  } finally {
    c.release();
  }

  const root = await verifyJob(f.jobId);
  const child = await verifyJob(childId);
  const grandchild = await verifyJob(grandchildId);

  assert.equal(root.reservation_status, 'RELEASED');

  assert.equal(child.parent_job_id, f.jobId);
  assert.equal(child.root_job_id, f.jobId);
  assert.equal(Number(child.attempt_number), Number(root.attempt_number) + 1);
  assert.equal(child.reservation_status, 'RELEASED');

  assert.equal(grandchild.parent_job_id, childId);
  assert.equal(grandchild.root_job_id, f.jobId);
  assert.equal(Number(grandchild.attempt_number), Number(child.attempt_number) + 1);
  assert.equal(grandchild.reservation_status, 'RESERVED');

  assert.notEqual(root.reservation_id, child.reservation_id);
  assert.notEqual(child.reservation_id, grandchild.reservation_id);
  assert.equal(await countRetryChildren(f.jobId), 1);
  assert.equal(await countRetryChildren(childId), 1);

  return 'C08 retry lineage + fresh reservation invariants';
}

async function run() {
  requireEnv('DATABASE_URL');
  requireEnv('DB_TEST_ADMIN_URL');

  const tests = [c01, c02, c03, c04, c05, c06, c07, c08];

  console.log('UGC Job API Concurrency Suite');
  console.log('=============================');

  let passed = 0;
  try {
    for (const test of tests) {
      const name = await test();
      passed += 1;
      console.log(`PASS ${name}`);
    }

    console.log('-----------------------------');
    console.log(`PASS ${passed}/${tests.length}`);
    console.log('Database Job API concurrency gate is GREEN.');
  } finally {
    await requestPool.end();
    await verifierPool.end();
  }
}

run().catch(async (err) => {
  console.error('FAIL Database Job API concurrency gate');
  console.error(err);

  try { await requestPool.end(); } catch (_) {}
  try { await verifierPool.end(); } catch (_) {}

  process.exit(1);
});
