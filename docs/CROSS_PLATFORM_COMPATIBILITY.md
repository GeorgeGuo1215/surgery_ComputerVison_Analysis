# PetOR Monitor 跨平台 Web 兼容说明

> 更新日期：2026-08-18
> 目标：同一套仅 HR 的 HTTPS Web/PWA 在 Windows、macOS、Android、iPhone/iPad 上运行，不要求安装原生客户端。SpO₂、PR、NIBP、RR、EtCO₂、FiCO₂、TEMP 均为后续范围。

## 支持矩阵

| 平台 | 推荐环境 | 摄像头 HR 识别 | 本地视频 HR 分析 | 安装方式 | 导出 |
|---|---|---:|---:|---|---|
| Windows 10/11 | 当前版 Edge 或 Chrome | 支持（仅前台） | 优先 H.264/AAC MP4 | 地址栏或浏览器菜单“安装应用” | CSV/JSON 下载 |
| macOS 13+ | Safari 17+ 或当前版 Chrome | 支持（仅前台） | H.264 MP4；MOV 取决于内部编码 | Safari“添加到程序坞”或 Chrome 安装 | CSV/JSON 下载 |
| Android 10+ | 当前版 Chrome | 条件支持（仅前台、真机待验） | 条件支持；优先 H.264/AAC MP4，1 秒性能不保证 | “安装应用/添加到主屏幕” | 系统分享面板或下载，真机待验 |
| iOS/iPadOS 17+ | Safari | 条件支持（仅前台、真机待验） | 条件支持；系统须可解码且提供安全抽帧能力，1 秒性能不保证 | Safari“分享 → 添加到主屏幕” | 系统分享面板，可“存储到文件”，真机待验 |

其他现代浏览器会按能力检测渐进运行，但发布验收以表中环境为准。摄像头依赖 HTTPS 或 localhost；GitHub Pages 部署后可以提供 HTTPS。[`getUserMedia()` 的安全上下文与授权要求](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)由浏览器强制执行。当前版本只存在于本地工作区，尚未 commit/push，GitHub Actions 未运行，Pages 也未部署。

## 已实现的跨端兼容措施

- 摄像头三层降级：指定设备 → 后置镜头偏好 → 任意可用镜头；权限拒绝不会反复弹窗。
- USB/外接摄像头热插拔后刷新设备列表；无视频轨道或播放失败时停止已获得的 track。
- `<video playsinline muted>`，避免 iPhone 强制全屏；媒体固有尺寸变化时更新画面比例。
- 导入前使用 [`canPlayType()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/canPlayType)提示格式风险，实际仍以浏览器解码结果为准。
- 离线视频只在 `requestVideoFrameCallback` 回调的 `metadata.mediaTime` 与目标时间匹配时抽取 Canvas 帧；可能复用旧画面的 `requestAnimationFrame`/定时回退已移除。不支持、超时或时间不匹配会明确失败，不会伪造该时间槽。
- iPhone/Android 优先使用 Web Share Files；用户取消分享不会重复触发下载，其他环境使用 Blob 下载并延迟释放 URL。
- 记录或离线分析期间按能力申请 [Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)；不支持时明确提示关闭自动锁屏。
- 页面进入后台时停止离线分析；摄像头 OCR 暂停。恢复时不自动续写或回填旧值。
- 使用 `100dvh`、四向 `safe-area-inset-*`、44 px 粗指针触控目标和可滚动软键盘对话框。
- 普通视频预览允许纵向滚动/缩放；只有 ROI 校准时才锁定触摸手势。
- PWA manifest 提供 192/512 PNG、maskable 图标和 180 px Apple touch icon；Windows/Android/macOS/iOS 均有安装入口或说明。WebKit 对主屏幕 Web App 与 manifest 图标的说明见 [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)，Chromium 桌面/Android 安装方式见 [web.dev](https://web.dev/learn/pwa/installation)。
- OCR Worker、SIMD/非 SIMD LSTM Core 和英文/数字模型均为同源固定资源，不再运行时请求第三方 CDN。Service Worker 安装时会连同应用外壳预缓存约 10.5 MB OCR 资源，但不缓存用户视频、Blob URL、病例导出或摄像头画面。
- 安装成 PWA 后再新建病例；iPhone/iPad 的 Safari 与主屏幕 Web App 可能使用分离存储，Safari 中的旧草稿不应假定会自动带入安装后的应用。
- 联合用药目录与事件和病例一样只保存在当前浏览器本机；跨设备不会自动同步。多药事件、审计和 CSV/JSON 导出在手机端仍需真机验证分享/下载行为。

## 重要限制

1. 后台或锁屏持续运行不受支持。手机浏览器切后台、锁屏或系统进入省电状态后，PetOR 必须安全暂停并要求人工恢复；不能把中断期间的缺失槽补成旧值。
2. `accept="video/*"` 只影响文件选择，不保证解码。跨平台统一交付格式应为 H.264 视频 + AAC 音频的 MP4；HEVC MOV、WebM 的支持随系统和浏览器变化。
3. 系统是否安装简体中文语音由设备决定。页面必须先用“测试播报”验证当前设备；没有中文声音时保留视觉记录与提示，不能把网页播报当作监护仪报警。
4. 第一次从远程地址打开应用仍需联网，这是 Web 分发的必然条件。Service Worker 成功安装并完成约 10.5 MB 资源预缓存后，应用外壳和 OCR 可在无第三方 CDN 的情况下工作。浏览器清缓存后需再次联网。
5. Windows/macOS GitHub Actions 只能证明依赖、类型和逻辑测试可运行；相机、iOS Safari、Android Chrome、系统分享和语音仍必须用真机发布验收。
6. 草稿为浏览器本机存储，无法代替正式病历系统。私密模式、系统清理或存储配额不足都可能使草稿失效，手术结束前必须导出 CSV 和 JSON。
7. Android/iOS 的 1 秒视频模式不保证吞吐、完成时间或一定完成；解码、OCR、散热、内存和省电限制都可能使其显著慢于桌面端或中止。长视频应优先在接电的桌面前台完成。
8. 本地视频分析要求浏览器支持并可靠返回带 `mediaTime` 的 rVFC。应用不会为了“兼容”而退回可能截取错误媒体帧的动画帧或定时方案。

## 发布前真机验收

每个平台至少执行一次：

1. 通过 HTTPS 打开并安装/添加到主屏幕。
2. 授权后置摄像头，核对分辨率、切换镜头和拒绝权限文案。
3. 导入相同 H.264 MP4，确认时长、比例、HR ROI 和两个五分钟 HR 槽；检查每个抽帧都由匹配目标 `mediaTime` 的 rVFC 回调确认。HR 横线时必须保持缺失，不能取用屏幕其他数字。
4. 启动记录后切后台 30 秒，再回前台；系统必须处于暂停状态且不回填旧值。
5. 测试简体中文播报、HR CSV/JSON 与用药 CSV/审计 CSV/JSON 的下载或系统分享、人工修订、本机恢复和病例清空。
6. 用医院自定义药名建立一条多药事件，确认没有默认药、默认剂量、自动计算或临床建议；复验编辑、删除和审计。
7. 横竖屏各检查一次刘海/安全区、软键盘、对话框保存按钮和页面横向溢出。
8. 如运行 1 秒模式，只记录该真机的完成/中止、实际耗时与资源表现，不设置与桌面端相同的性能通过线。

Android 与 iOS 真机通过前，交付状态只能表述为“移动端前台条件适配、真机验收待完成”，不能表述为“四平台可用”或“四平台临床可用”。后台/锁屏能力不在后续真机验收目标内，因为当前产品明确不支持。
