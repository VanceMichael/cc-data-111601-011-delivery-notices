# delivery-notices

邀请邮件退信中逐收件人的状态采集相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

- MIME 邮件头查看和原件目录（兼容接口）。
- RFC 3464 delivery-status 子集的结构化接收：`multipart/report` 中的 `message/delivery-status` part 与独立 `message/delivery-status`，按收件人逐块保存动作、增强状态码、诊断码与原信线索；`text/plain` 与 `message/rfc822` 正文里的同名字段不属于 DSN，不会被采集。
- 按可关联的发送尝试核对结果，跨通知维护逐（尝试, 收件人）台账：晚到的“暂缓”不覆盖已确认终态；线索不足、原始/最终收件人不一致或通知自相矛盾时保留疑点，不推断邮箱永久无效。

`src/reader.mjs` 提供现有单件读取契约；`src/dsn.mjs` 负责 DSN 结构解析；`src/reconcile.mjs` 负责尝试关联与跨通知核对；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、结构化通知和解释结果。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、读取已保存结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /attempts，JSON 为 {"attempts":[...]} 或直接数组：登记发送尝试清单快照（含 id、messageId、recipients），是 DSN 关联的事实依据；GET /attempts 读取当前快照。
- POST /notices，JSON 为 {"path":"/primary"}：领取并结构化解释 DSN，逐收件人保存 Action、Status、Diagnostic-Code、原始/最终收件人、原信 Message-ID 与关联结论；同 source URL、同摘要重领返回 `duplicated: true` 与原记录。
- GET /notices：全部结构化通知。
- GET /ledger：逐（尝试, 收件人）核对台账，含每次观察、当前动作、已确认终态、疑点与无法关联的 unresolved 观察。

前四项是兼容接口，保持原有语义，GET 请求不会变为写操作。收件记录中的单件 raw 对象不代表关联资料已完整。

## 关联与核对规则

- 关联线索为通知级 Original-Envelope-Id、原信 Message-ID 与块级原始/最终收件人。标识线索唯一命中且无疑点为 `matched`；带疑点（如收件人改写）为 `doubtful`；多个候选或标识互相冲突为 `ambiguous`；无线索或标识无对应尝试为 `unmatched`，绝不挑第一个候选。
- 原始收件人与最终收件人不一致时保留双方与改写疑点，仅以同通知内线索给出带疑点的别名提示；收件人不在尝试名单内同样保留疑点。
- 台账以（发送尝试 id, 收件人）为键，失败只落到具体尝试的具体收件人，不影响同封其他收件人，也不产生地址全局无效结论。
- `failed/delivered/relayed/expanded` 为已确认终态；晚到的 `delayed` 不覆盖终态，只追加观察并标记 `late_delayed_after_terminal`。终态互相矛盾时保留双方观察并标记 `terminal_conflict`。
- 所有无法确定的情形进入条目疑点或 `/ledger` 的 unresolved，而不是转换成已确认的空结果。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；DSN 解析行为在 test/dsn.test.mjs，尝试关联与跨通知台账在 test/reconcile.test.mjs，通知接收的端到端行为在 test/notices.test.mjs，领域读取行为在 test/domain.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t delivery-notices:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
