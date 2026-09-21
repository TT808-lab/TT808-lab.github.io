# MiniMax 朗读中转

Course Reader 不把 MiniMax API key 放进 GitHub Pages。需要朗读时，浏览器只把当前句子发给自己的中转服务，中转服务请求 MiniMax 并把短暂的音频响应返回给浏览器；PDF、图片和整本书不会上传。

先在电脑上设置环境变量，再启动已有的本地 Course Reader 服务：

```powershell
$env:MINIMAX_API_KEY = '把你的 MiniMax API key 放在这里'
$env:MINIMAX_MODEL = 'speech-2.8-turbo'
node scripts/serve.mjs
```

电脑浏览器打开 `http://127.0.0.1:4179/tools/course-reader/`，在“MiniMax 朗读”卡片里保存：

```text
http://127.0.0.1:4179/api/minimax-tts
```

手机和电脑连同一个 Wi-Fi 时，将 `127.0.0.1` 换成电脑局域网 IP，并把服务绑定到局域网地址：

```powershell
$env:MINIMAX_API_KEY = '把你的 MiniMax API key 放在这里'
$env:COURSE_READER_HOST = '0.0.0.0'
$env:MINIMAX_ALLOWED_ORIGIN = 'http://电脑局域网IP:4179'
node scripts/serve.mjs
```

然后手机打开 `http://电脑局域网IP:4179/tools/course-reader/`，保存 `http://电脑局域网IP:4179/api/minimax-tts`。局域网模式下可以设置 `MINIMAX_RELAY_SECRET`，并在网页卡片中填写相同的中转密钥。

默认使用 `speech-2.8-turbo` 和中文有声书女声 `audiobook_female_1`。阅读器里可以切换其他中文音色或 `speech-2.8-hd`；HD 音质更高，额度消耗也更高。每次只请求当前朗读片段，浏览器播放完即释放，不提供整本 MP3 下载。

## 公网手机使用

GitHub Pages 本身不能安全保存 API key。公网版本使用 `api/minimax-tts.mjs` 部署到 Vercel，API key 和独立的 `MINIMAX_RELAY_SECRET` 只保存在 Vercel 环境变量中。中转只接受来自 `https://tt808-lab.github.io` 的请求、最多 300 字的单个朗读片段以及白名单内的音色。

首次在手机配置时，使用带 `minimax_setup` 查询参数的专属链接。页面会将中转地址和口令保存到该浏览器的 localStorage，并立即从地址栏移除口令。不要公开分享专属设置链接；平时分享不含查询参数的 Course Reader 地址即可。
