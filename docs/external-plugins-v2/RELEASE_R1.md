# Readest Remote 0.12.12-r1

本版基于 Readest 0.12.12，沿用 Readest Remote 的名称、包名和协议，外部书库改为独立插件。

## 从 V1 升级

首次启动会备份应用管理的旧数据，然后建立空白书库和设置。旧 Kavita 连接不迁移，需要安装插件并重新配置。应用外部的自定义书籍目录不移动，也不删除。

便携版沿用 V1 布局，`settings.json` 和 `Readest` 书籍目录位于 EXE 旁，WebView 缓存使用上游的 Windows 用户目录。

备份保存在原应用数据目录下的 `ReadestRemoteBackups/v1-<时间戳>`。便携版的备份位于可执行文件旁。`manifest.json` 记录每个数据项的原路径和备份路径，`RESTORE.txt` 说明恢复步骤。备份使用同一文件系统内的重命名，保留原始文件内容；中断后根据日志继续。备份失败时不进入新书库。

恢复前关闭应用，把新版产生的数据另行保存，再按清单恢复旧数据并安装 V1。返回 V1 时删除 `.readest-remote-generation` 标记，以便以后重新升级时备份最新旧数据。不要让两个版本同时使用同一数据目录。

## 插件

仓库：https://github.com/WenHe233/readest-remote-plugins

源地址：`https://wenhe233.github.io/readest-remote-plugins/repo.json`

在“设置 → 插件 → 插件源”添加地址，安装 Kavita 或 Komga 并确认签名者和权限。两个插件的首个公开版本为 `0.1.1`，插件 API 仍为 V2。

签名者指纹：`53bd64d1d5c13cd5010e0e46dd1e521d3a296fa41c6e7ce1767266890ba2092e`。

## 云同步与验证范围

本次安装包关闭 Readest 登录及云同步，不连接官方服务或本机验收服务。Kavita、Komga 自身的阅读进度同步保留。自部署云端代码和迁移文件仍在仓库中，可按 SELF_HOSTING.md 单独构建启用。

本地运行验收以 Windows x64 为主，其他平台通过 GitHub Actions 验证构建。Komga EPUB 在服务器网页阅读器中切换章节的人工验证尚未完成，不计为通过；服务器 Progression API 与原生进度往返已有测试记录。


Windows x64 已验证全新安装、V1 覆盖升级、逐文件备份校验与恢复、备份失败后继续、重启、重复安装及便携版。测试使用旧数据的副本，结束后已恢复原始数据目录。完整单元测试 12,946 项通过，浏览器测试 681 项通过；原生书库与插件测试、Rust 检查和全平台构建记录见[验收记录](https://github.com/WenHe233/readest-remote/blob/feat/external-plugins-v2/docs/external-plugins-v2/verification-r1.json)。

Android 沿用 V1 签名证书。macOS DMG 和 iOS IPA 沿用 V1 的未签名构建方式。
