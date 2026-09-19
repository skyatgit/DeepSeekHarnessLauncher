// 打包前清空输出目录（npm run dist 会先执行本脚本）
// 目的：产物目录里只保留本次构建的结果，不残留旧版本的安装包 / blockmap
// 用法：node scripts/clean.js [目录...]   不传参数时默认清理 release
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['release']

for (const target of targets) {
  const abs = path.resolve(root, target)
  // 只允许清理项目目录内的子路径，避免手滑传成项目根或盘符
  if (abs === root || !abs.startsWith(root + path.sep)) {
    console.error('拒绝清理项目目录之外的路径: ' + abs)
    process.exit(1)
  }
  fs.rmSync(abs, { recursive: true, force: true })
  console.log('已清空 ' + path.relative(root, abs))
}
