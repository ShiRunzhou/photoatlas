const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');
const [source, target, reportFile] = process.argv.slice(2);
if (!source || !target || !reportFile)
  throw Error('需要源目录、目标目录和报告路径');
function list(root) {
  const rows = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (e.isFile()) rows.push(path.relative(root, file));
    }
  }
  walk(root);
  return rows;
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function run() {
  const files = list(source);
  let done = 0,
    bytes = 0,
    index = 0;
  const failures = [];
  const entries = [];
  async function worker() {
    while (index < files.length) {
      const relative = files[index++];
      try {
        const src = path.join(source, relative),
          dst = path.join(target, relative),
          a = fs.statSync(src),
          b = fs.statSync(dst);
        if (a.size !== b.size) throw Error('大小不一致');
        const [ha, hb] = await Promise.all([digest(src), digest(dst)]);
        if (ha !== hb) throw Error('SHA256 不一致');
        bytes += a.size;
        entries.push({ relative, size: a.size, sha256: ha });
      } catch (error) {
        failures.push({ relative, error: error.message });
      }
      done++;
      if (done % 200 === 0) console.log(`${done}/${files.length}`);
    }
  }
  await Promise.all([worker(), worker()]);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(
    reportFile,
    JSON.stringify(
      {
        source,
        target,
        files: files.length,
        verified: entries.length,
        bytes,
        failures,
        entries,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      files: files.length,
      verified: entries.length,
      failures: failures.length,
    }),
  );
  if (failures.length) process.exitCode = 1;
}
run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
