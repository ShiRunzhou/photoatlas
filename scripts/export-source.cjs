'use strict';
// Export only public source. Never include the installed collection or Git history.
const fs = require('fs'),
  path = require('path');
const project = path.resolve(__dirname, '..');
const entries = [
  '.github',
  '.gitignore',
  '.prettierrc.json',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  '启动PhotoAtlas.cmd',
  'assets',
  'desktop',
  'docs',
  'scripts',
  'tests',
];
function exportSource(destination) {
  const target = path.resolve(destination);
  const relative = path.relative(project, target);
  const reverse = path.relative(target, project);
  const nested = (rel) =>
    !path.isAbsolute(rel) && !rel.startsWith(`..${path.sep}`) && rel !== '..';
  if (nested(relative) || nested(reverse))
    throw Error('导出目录必须在项目目录之外，且不能是项目的父目录');
  if (fs.existsSync(target))
    throw Error('导出目录已存在，请指定新的空目录路径');
  let parent = target;
  const remaining = [];
  while (!fs.existsSync(parent)) {
    remaining.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  const realTarget = path.join(fs.realpathSync(parent), ...remaining),
    realProject = fs.realpathSync(project);
  if (
    nested(path.relative(realProject, realTarget)) ||
    nested(path.relative(realTarget, realProject))
  )
    throw Error('导出目录的实际位置不能位于项目内或其父目录');
  for (const name of entries)
    if (!fs.existsSync(path.join(project, name)))
      throw Error(`发布文件缺失：${name}`);
  const files = [];
  function inspect(file, rel) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw Error(`发布目录不允许链接：${rel}`);
    if (
      /(?:^|[\\/])(?:\.git|data|node_modules|Photos|Library)(?:[\\/]|$)|(?:^|[\\/])\.env(?:\.|$)|\.(?:pfx|p12|pem|key|lnk|log|tmp)$/i.test(
        rel,
      )
    )
      throw Error(`发布目录中有私有或运行文件：${rel}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file))
        inspect(path.join(file, name), path.join(rel, name));
    } else files.push(rel);
  }
  for (const name of entries) inspect(path.join(project, name), name);
  fs.mkdirSync(target, { recursive: true });
  for (const name of entries)
    fs.cpSync(path.join(project, name), path.join(target, name), {
      recursive: true,
    });
  return { destination: target, files: files.length };
}
if (require.main === module) {
  try {
    const destination = process.argv[2];
    if (!destination || process.argv.length !== 3)
      throw Error('用法：npm run export:source -- <新的导出目录>');
    console.log(JSON.stringify(exportSource(destination), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { exportSource };
