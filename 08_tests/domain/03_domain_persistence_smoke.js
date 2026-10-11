const { Pool } = require('pg');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');

const pool = new Pool({ connectionString: process.env.DB_TEST_ADMIN_URL || process.env.DATABASE_URL });

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const userId = randomUUID();
  const workspaceId = randomUUID();
  const productId = randomUUID();
  const secondProductId = randomUUID();
  const storyboardId = randomUUID();

  await pool.query(`INSERT INTO auth.users(id,email,role) VALUES($1,$2,'authenticated')`, [
    userId,
    `domain-${userId}@example.test`,
  ]);
  await pool.query(`INSERT INTO public.workspaces(id,name,slug) VALUES($1,'Domain CI',$2)`, [
    workspaceId,
    `domain-${workspaceId}`,
  ]);
  await pool.query(
    `INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`,
    [workspaceId, userId],
  );
  await pool.query(
    `INSERT INTO public.credit_accounts(workspace_id,balance,reserved_credits) VALUES($1,1000,0)`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO public.products(id,workspace_id,name,description) VALUES($1,$2,'Product A','CI product'),($3,$2,'Product B','Conflict product')`,
    [productId, workspaceId, secondProductId],
  );
  await pool.query(
    `INSERT INTO public.storyboards(id,workspace_id,product_id,payload,script_content)
     VALUES($1,$2,$3,'{}'::jsonb,'UGC smoke script')`,
    [storyboardId, workspaceId, productId],
  );

  const key = `domain-smoke-${randomUUID()}`;
  const first = await pool.query(
    `SELECT private.create_domain_job_and_reserve_credits($1,'ugc_video',$2,$3,$4,$5) AS job_id`,
    [workspaceId, userId, key, productId, storyboardId],
  );
  const jobId = first.rows[0].job_id;
  assert.ok(jobId);

  const binding = await pool.query(
    `SELECT product_id,storyboard_id FROM public.job_domain_inputs WHERE job_id=$1`,
    [jobId],
  );
  assert.equal(binding.rowCount, 1);
  assert.equal(binding.rows[0].product_id, productId);
  assert.equal(binding.rows[0].storyboard_id, storyboardId);

  const outbox = await pool.query(
    `SELECT status,payload,dispatch_key FROM public.job_dispatch_outbox WHERE job_id=$1`,
    [jobId],
  );
  assert.equal(outbox.rowCount, 1);
  assert.equal(outbox.rows[0].status, 'pending');
  assert.equal(outbox.rows[0].payload.jobId, jobId);
  assert.equal(outbox.rows[0].dispatch_key, `initial:${jobId}`);

  const reservation = await pool.query(
    `SELECT amount,status FROM public.credit_reservations WHERE job_id=$1`,
    [jobId],
  );
  assert.equal(reservation.rowCount, 1);
  assert.equal(reservation.rows[0].status, 'RESERVED');
  assert.equal(Number(reservation.rows[0].amount), 150);

  const repeated = await pool.query(
    `SELECT private.create_domain_job_and_reserve_credits($1,'ugc_video',$2,$3,$4,$5) AS job_id`,
    [workspaceId, userId, key, productId, storyboardId],
  );
  assert.equal(repeated.rows[0].job_id, jobId);

  let conflict = null;
  try {
    await pool.query(
      `SELECT private.create_domain_job_and_reserve_credits($1,'ugc_video',$2,$3,$4,$5)`,
      [workspaceId, userId, key, secondProductId, storyboardId],
    );
  } catch (error) {
    conflict = error;
  }
  assert.ok(conflict, 'reusing an idempotency key with another domain binding must fail');
  assert.equal(conflict.code, '22023');

  console.log('PASS domain persistence smoke: atomic job/billing/binding/outbox + strict binding idempotency');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
