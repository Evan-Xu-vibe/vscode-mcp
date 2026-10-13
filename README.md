# VSCode MCP

在 VS Code 桌面窗口内运行本地 MCP 服务，让外部 Agent 读取工作区和未保存代码、修改文件、查询诊断信息。支持 VS Code 1.85.0 及以上版本。

## 使用第一版

1. 在扩展面板的菜单中选择 **Install from VSIX...**，安装 `vscode-mcp-0.1.3.vsix` 并重新加载窗口；或按下面的开发步骤运行。
2. 打开要提供给 Agent 的本机工作区。
3. 点击左侧活动栏的 **VSCode MCP** 插头图标，在“服务控制”侧边栏点击 **启动服务**。
4. 按需点击 **连接验证已开启 / 已关闭** 切换验证，点击 **设置 / 更改 Key** 保存自定义 Key；修改后停止并重新启动服务。点击 **复制连接信息** 获取 URL，开启验证时还会包含 Authorization 请求头。
5. 按下面的客户端配置示例接入。让 Agent 先调用 `workspace_info`，核对工作区后再读写文件。

状态栏显示当前端口，点击可复制连接信息。服务默认手动启动，停止或关闭窗口后连接不可用。连接验证可选，默认开启：设置自定义 Key 后重启服务仍使用同一个 Key；未设置时每次启动生成随机 Key；关闭验证后无需凭据。默认端口每次启动也可能变化，可以在设置中指定固定端口。

自定义 Key 支持 1–1024 个可打印 ASCII 字符，不包含空格，保存在 VS Code 密钥存储中。关闭验证时也可预先设置 Key，之后开启验证并重启服务即可使用。点击 **清除自定义 Key** 后，开启验证的服务下次启动会生成随机 Key。

## 接入 Codex

在 `%USERPROFILE%\.codex\config.toml` 中添加以下配置，替换示例 URL 和凭据。`Authorization` 的完整值可从复制的连接信息中取得。不要把真实凭据提交到仓库。

```toml
[mcp_servers.vscode]
url = "http://127.0.0.1:实际端口/mcp"
http_headers = { Authorization = "Bearer 实际凭据" }
```

关闭连接验证时，删除 `http_headers` 行，只保留 URL 即可。

重新连接 MCP 或重启客户端。配置格式参考 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。此版本已使用官方 MCP SDK 客户端做端到端验证，尚未在 Codex、OpenCode 产品中分别完成实测。

## 接入 OpenCode

将以下片段合并到 `opencode.json` 中，替换 URL 和凭据：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "vscode": {
      "type": "remote",
      "url": "http://127.0.0.1:实际端口/mcp",
      "enabled": true,
      "oauth": false,
      "headers": { "Authorization": "Bearer 实际凭据" }
    }
  }
}
```

这里 `remote` 表示通过 HTTP 连接，服务实际仍运行在本机。参考 [OpenCode 官方 MCP 文档](https://opencode.ai/docs/mcp-servers/)。

关闭连接验证时，删除 `headers` 字段即可。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `workspace_info` | 窗口实例、工作区根目录、权限和限制 |
| `files_list` | 列出目录，支持分页 |
| `files_search` | 搜索单行字面文本，支持 glob 和大小写选项 |
| `file_read` | 读取最新编辑器内容，支持行范围及长度限制 |
| `file_write` | 创建文件或替换现有文件内容 |
| `file_apply_edits` | 对单文件应用多处不重叠的范围修改 |
| `file_save` | 保存指定文件 |
| `editor_context` | 当前文件、选区和已加载文档元数据 |
| `editor_open` | 打开工作区文件并定位 |
| `diagnostics_get` | 查询 VS Code 当前报告的错误和警告 |

详细参数、冲突行为和错误码见 [工具说明](docs/tools.md)。

## 文件读写约定

- `path` 支持绝对本机路径、`file:` URI、相对工作区路径。多根工作区的相对路径必须附带 `workspace_info` 返回的 `root` URI。
- `file_read` 读取编辑器缓冲区，包括未保存修改；`contentHash` 始终对应完整内容，即使只读取部分行。
- 修改现有文件和保存时必须提供 `expectedHash`。若用户或其他客户端改变了内容，会返回 `VERSION_CONFLICT`，需要重新读取。
- 编辑现有文件默认不保存，可用 `save: true` 或单独调用 `file_save`。修改支持 VS Code 撤销/重做。
- 创建文件用 `create: true`；父目录必须存在。创建操作会先在磁盘创建空文件，然后将正文放入编辑器；用 `save: true` 将正文保存到磁盘。
- 行号和列号从 1 开始，列按 UTF-16 计数，修改范围结束位置不包含在内；读取的 `endLine` 则包含该行。
- VS Code 会按文档设置处理换行和编码，保存参与者可能执行格式化；以返回的内容摘要和后续读取结果为准。

## 设置和边界

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `vscodeMcp.autoStart` | `false` | 窗口启动后自动运行服务，修改后重新加载窗口 |
| `vscodeMcp.port` | `0` | 自动分配端口，可设置固定端口；修改后重启服务 |
| `vscodeMcp.auth.enabled` | `true` | 是否要求 Bearer Key；可关闭验证，修改后重启服务 |
| `vscodeMcp.allowWrites` | `true` | 是否允许创建、修改和保存文件，立即生效 |

服务仅监听 `127.0.0.1`，验证开启时使用自定义或随机 Bearer Key，所有模式均检查 Host/Origin；路径限定在工作区，拒绝指向工作区外的符号链接和目录联接。未受信任工作区禁止文件修改。每个窗口有独立服务，随机 Key 每次启动生成，自定义 Key 由此扩展的密钥存储保存。

第一版支持本机文本文件和 Streamable HTTP 的无状态 JSON 响应模式，不提供 SSE 事件订阅、stdio 桥接、调试变量、调试控制或远程工作区。单个文本文件限制 1 MiB，单次读取最多 64 Ki 个字符；搜索最多扫描 200 个文件、返回 200 个匹配，默认排除依赖、Git 和构建目录。结果中的 `truncated`、`skippedFiles` 必须检查。诊断为空不代表语言服务已完成检查。

## 开发

1. 安装 Node.js 22 或更新的 LTS 版本（包含 npm）。
2. 在工程目录执行 `npm.cmd ci`。
3. 用 VS Code 打开当前目录，按 **F5**，启动插件开发宿主。
4. 在新窗口按 **Ctrl+Shift+P**，执行 **VSCode MCP: 启动 MCP 服务**。

修改代码后执行 `npm.cmd run compile`，在开发宿主执行 **Developer: Reload Window** 重新加载插件；持续打包可以使用 `npm.cmd run watch`。插件运行不依赖用户机器上的 npm，npm 仅用于工程开发。

修改 `package.json` 中的配置或命令声明后，需要重新加载开发宿主窗口（或关闭宿主后重新按 F5），仅编译代码不会重新注册配置。若切换验证时报“没有注册配置 vscodeMcp.auth.enabled”，请先重新加载窗口。未打开工作区时，验证开关保存到用户设置；打开工作区时保存到工作区设置。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm.cmd run compile` | 类型检查、编译并打包运行代码 |
| `npm.cmd run watch` | 监听并重新打包，类型检查另用 check |
| `npm.cmd run check` | 类型检查 |
| `npm.cmd test` | 单元测试和真实 VS Code 集成测试 |
| `npm.cmd run test:unit` | 仅运行单元与 HTTP 协议测试 |
| `npm.cmd run package` | 生成 VSIX 安装包 |

集成测试默认下载 VS Code 1.85.0，并使用独立临时工作区和配置；可指定已安装的 VS Code 来避免下载：

```powershell
$env:VSCODE_EXECUTABLE_PATH = 'E:\Software\Microsoft VS Code\Code.exe'
npm.cmd test
```

测试覆盖 MCP 初始化、工具发现、请求认证、路径越界、符号链接、未保存内容、读取范围、撤销/重做、修改冲突、并发写入、保存、写入禁用、文件创建、大小限制、搜索和诊断。

## 工程结构

- `src/extension.ts`：插件入口、服务管理、状态栏和用户命令。
- `src/server.ts`：本机 HTTP 服务、连接验证和 MCP 传输。
- `src/tools.ts`：10 个工作区与文件工具。
- `src/core.ts`：路径边界、摘要和写入队列。
- `src/test/`：协议、边界和 VS Code 集成测试。
- `scripts/`：构建和测试入口。
- `package.json`：插件清单、命令声明和开发脚本。
- `.vscode/launch.json`：F5 调试配置。
- `.vscode/tasks.json`：调试前编译和打包。

运行代码打包到 `dist/extension.js`，VSIX 不包含开发依赖和测试代码。发布到 Marketplace 前，需要设置自己的 `publisher`、仓库信息和许可证。

参考：[VS Code 官方插件开发指南](https://code.visualstudio.com/api/get-started/your-first-extension)。
