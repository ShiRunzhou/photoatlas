# 源码发布

公开仓库应只包含源码、依赖锁文件、公开城市资料、文档和生成的示例界面。不要上传 `Photos`、`Library`、`data`、`node_modules` 或签名证书。

## 导出公开源码

先通过验证，再指定一个尚不存在、位于项目外部的目录：

```powershell
npm test
npm run check:formats
npm run test:desktop
npm run export:source -- "D:\PhotoAtlasSource"
```

导出工具按明确列表复制发布文件，拒绝符号链接、私有目录、证书和快捷方式，不复制 `.git`。它不创建 GitHub 仓库，不执行提交或推送，也不改变原工作目录。不要用直接复制整个项目文件夹的方法代替它。

导出的目录可作为仓库的初始源码。继续保留 [LICENSE](../LICENSE)、README 中的原作者声明和 [资料归属](../assets/ATTRIBUTION.md)。

## 私有数据误提交

如果照片、管理数据或证书曾被提交，删除当前文件或添加忽略规则不能清除已经公开的内容。涉及私钥时，应先停用或替换凭据，再制定历史清理方案。改写远程历史会改变提交编号并影响其他克隆，应先备份并明确协调方式。

GitHub 的[敏感数据清理说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)解释了历史重写及已存在克隆、分支和缓存的限制。发布工具不会自动改写远程历史或更改 Windows 证书信任设置。

## 发布检查

- 用导出的源码在新目录运行 `npm ci`，完成测试，确认不依赖本机已有的缓存和数据库。
- 确认文档图片为生成的示例，README 没有个人照片数量或个人路径。
- 保留原项目许可和第三方资料声明。
- 当前未提供独立安装包；不要将源码发布描述成已提供即装即用的应用。
- 上传后检查 Windows Actions 的实际结果。仅本机通过测试，不代表远程 CI 已经运行。
