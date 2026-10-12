// 复现 7.4：未知事件名命中对象继承成员，导致事件明细接口 500。
const BASE = `http://localhost:${process.env.PORT || '5725'}`;

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@test.local', password: 'AdminPass123!' }),
});
const { token } = await login.json();
const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

const NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'normal_unknown'];

console.log('=== 1) 通过现有上报接口写入这些事件名 ===');
for (const name of NAMES) {
  const r = await fetch(`${BASE}/api/analytics/events`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ eventType: name, eventData: { probe: true } }),
  });
  console.log(`  POST eventType=${name.padEnd(16)} -> HTTP ${r.status}`);
}

console.log('\n=== 2) 逐个按类型过滤查询 ===');
for (const name of NAMES) {
  const r = await fetch(`${BASE}/api/admin/analytics/events?type=${encodeURIComponent(name)}`, {
    headers: auth,
  });
  const body = await r.text();
  const detail = r.status === 200 ? body.slice(0, 90) : body.slice(0, 80).replace(/\s+/g, ' ');
  console.log(`  type=${name.padEnd(16)} -> HTTP ${r.status}  ${detail}`);
}

console.log('\n=== 3) 不带过滤的整页查询（关键：整页是否会一起挂） ===');
const all = await fetch(`${BASE}/api/admin/analytics/events`, { headers: auth });
console.log(`  GET /api/admin/analytics/events -> HTTP ${all.status}`);
console.log('  ' + (await all.text()).slice(0, 160));
