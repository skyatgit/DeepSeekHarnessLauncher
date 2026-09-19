// 校验 Git 标签与 package.json 版本是否一致（CI 在打 tag 时运行）
//
// 为什么单独一个文件：这段逻辑原来是用 `run: node -e "..."` 内联写在
// .github\workflows\release.yml 里的，脚本中的 "标签与版本一致: " 含「冒号 + 空格」，
// 而 YAML 的未加引号标量里 `: ` 是映射分隔符 → 整个工作流被判 "Invalid workflow file"
// （GitHub 报第 33 行）。挪出 YAML 既没有引号地狱，也能在本地直接跑：
//   node scripts/check-tag.js v1.0.5     # 一致 → 退出码 0
//   node scripts/check-tag.js v1.0.4     # 不一致 → 退出码 1
// CI 中不传参时读环境变量 GITHUB_REF_NAME。
const pkg = require('../package.json')

const raw = process.argv[2] || process.env.GITHUB_REF_NAME || ''
if (!raw) {
  console.error('用法: node scripts/check-tag.js <标签，如 v1.0.5>（CI 中读环境变量 GITHUB_REF_NAME）')
  process.exit(1)
}

const tag = String(raw).trim().replace(/^v/, '')
if (tag !== pkg.version) {
  console.error('标签 v' + tag + ' 与 package.json 版本 ' + pkg.version + ' 不一致，请先升版本再打标签')
  process.exit(1)
}

console.log('标签与版本一致: ' + pkg.version)
