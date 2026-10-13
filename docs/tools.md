# 第一版工具接口

每个成功结果同时提供 MCP `structuredContent` 和 JSON 文本。失败返回 `isError: true`，内容格式为 `{ "error": { "code": "...", "message": "..." } }`。参数格式错误由 MCP SDK 校验并返回工具错误。

## 定位文件

文件工具使用 `path`，可选 `root`。多根工作区先调用 `workspace_info`，使用根目录的 `uri` 作为 `root`。文件、目录必须位于本机工作区；不支持网络路径或 Windows Alternate Data Streams。

```json
{ "path": "src/main.ts", "root": "file:///e%3A/Project/my-app" }
```

## 查询

- `workspace_info`：无参数。返回 `instanceId`、`roots`、`trusted`、`capabilities`、`limits` 和坐标约定。
- `files_list`：`path`、可选 `root`，`offset=0`、`limit=100`（最大 500）。返回 `entries`、`total`、`nextOffset`。
- `file_read`：`path`、可选 `root`、`startLine=1`、`endLine`、`maxCharacters=65536`。返回 `text`、`truncated`、`uri`、`contentHash`、`version`、`isDirty`、`lineCount`、`languageId`。空文件有一行。返回文本不包含指定末行后的换行。
- `files_search`：`query`（单行字面文本，非正则）、`glob="**/*"`、可选 `root`、`caseSensitive=true`、`limit=50`（最大 200）。返回匹配位置与简短上下文、扫描和跳过数量、截断标识。搜索已有文件的最新文档内容，不扫描未命名文档。
- `editor_context`：无参数。返回允许访问的已加载文档元数据和当前编辑器选区；文档列表最多 200 条，不包含正文。
- `editor_open`：`path`、可选 `root`、`line=1`、`column=1`。
- `diagnostics_get`：可选 `path`、`root`，`limit=100`（最大 500）。返回当前已有诊断及严重级别、来源和位置。它不会主动等待语言服务完成分析。

## 替换或创建

```json
{
  "path": "src/main.ts",
  "text": "console.log('updated');\n",
  "expectedHash": "从 file_read 获取的 64 位 SHA-256 摘要",
  "save": false
}
```

新文件改用 `create: true`，省略 `expectedHash`。已存在文件不会被 create 覆盖。父目录必须存在。需要将正文立即落盘时传 `save: true`。

## 范围修改

`file_apply_edits` 接受一个文件上的多个范围修改，范围基于同一份原始内容，彼此不可重叠。结束坐标不包含在修改范围内。相同起止位置表示插入；相同插入点不能重复指定。

```json
{
  "path": "src/main.ts",
  "expectedHash": "从 file_read 获取的摘要",
  "edits": [
    { "start": { "line": 3, "column": 1 }, "end": { "line": 3, "column": 4 }, "text": "let" }
  ],
  "save": false
}
```

返回修改后的摘要和 `isDirty`、`saved`。最多 100 处修改，结果仍须在 1 MiB 限制内。当前不提供跨文件原子修改。

## 保存

`file_save` 参数为 `path`、可选 `root`、`expectedHash`。应使用上次修改返回的摘要；保存前再次检查内容，避免保存用户后来输入的改动。保存参与者可能改变正文；返回摘要对应保存后的编辑器内容。

## 常见错误

| 错误码 | 客户端处理 |
| --- | --- |
| `ROOT_REQUIRED` | 从 workspace_info 获取并指定根 URI |
| `PATH_DENIED` | 使用工作区内普通文件路径 |
| `HASH_REQUIRED` | 先读取文件，再提供摘要 |
| `VERSION_CONFLICT` | 重新读取并重新计算修改范围 |
| `INVALID_RANGE` / `OVERLAPPING_EDITS` | 修正坐标或拆分重叠修改 |
| `ALREADY_EXISTS` | 读取现有文件，按替换流程处理 |
| `FILE_TOO_LARGE` / `BINARY_FILE` | 使用适合该文件的其他工具 |
| `WORKSPACE_UNTRUSTED` / `WRITE_DISABLED` | 当前不允许写入，交由用户调整设置 |
| `SAVE_FAILED` | 检查编辑器状态；修改可能仍留在缓冲区 |
| `FileNotFound` / `NoPermissions` | 检查文件位置和系统权限 |

日志只记录工具名称、结果码与耗时，不记录凭据、正文或工具参数。
