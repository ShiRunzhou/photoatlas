# 问题反馈与开发

## 报告问题

请在当前仓库的 Issues 中说明：

1. 项目版本、Windows 版本，以及 `node --version` 的结果。
2. 操作步骤、预期结果、实际结果和错误文字。
3. 如与文件有关，提供格式、尺寸及问题是否可以用不含个人信息的示例图片重现。

不要直接上传整个 `data` 目录或自己的照片库。截图中请遮挡照片、个人路径和地点信息；日志或管理记录也可能包含这些内容。安全问题请参阅 [SECURITY.md](SECURITY.md)。

## 开发环境

Windows，Node.js 22.12.0 或更高版本。使用 `npm ci` 安装锁定的依赖，`npm start` 启动桌面程序。

```powershell
npm test
npm run check:formats
npm run test:desktop
npm run docs:screenshots   # 使用生成的示例图片更新 README 截图
```

核心和桌面测试使用临时目录。桌面测试会在临时照片中验证真正的删除和快捷方式读写，不会操作使用者照片库。`tests/installed.cjs` 是用于本机人工核验的辅助脚本，不属于自动测试；它会读取当前照片库并保存界面截图，因此不要把它当成通用测试入口。

涉及删除、入库状态、照片信息或链接归属的改动，应验证失败时不会误删文件或丢失信息。普通界面文案和样式调整不要求增加镜像测试。

提交中只应包含源码、公开资料和测试示例。不要添加原图、快捷方式、管理数据、下载的运行时或签名证书。格式遵循 `.prettierrc.json`，依赖变化时一并更新 `package-lock.json`。

贡献沿用 [LICENSE](LICENSE) 中的许可，保留原作者的 Required Notice 声明。
