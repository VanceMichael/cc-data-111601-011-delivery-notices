# delivery-notices

邀请邮件退信中逐收件人的状态采集相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

接收并结构化解释 RFC 3464 delivery-status 通知（multipart/report 的 message/delivery-status part，或单独 message/delivery-status），同时保留 MIME 邮件头查看和原件目录。

`src/dsn.mjs` 逐收件人解释动作、增强状态码、诊断与原信线索，并按来源发送尝试核对；`src/reader.mjs` 提供现有单件读取契约；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、结构化通知和解释结果。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、读取已保存结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

直接 `npm start` 即可启动产品，默认自动在临时回环端口创建本地合成来源，产品默认监听 127.0.0.1:4102。退出产品时同步关闭自带来源。需要联调独立来源时先运行 `npm run source`，再设置 SOURCE_URL=http://127.0.0.1:4101 运行 `npm start`；显式来源不会由产品关闭。DATA_DIR 可设置资料目录，PORT 可覆盖产品监听端口。构建产物位于 dist，启动、测试与演示均不需要外部服务或下载。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /notices，JSON 为 {"path":"/primary"}：领取并结构化解释 delivery-status 通知，保存原件并登记逐收件人结果；非通知内容或解释失败不登记。
- GET /notices：已登记通知目录；同 source URL、同摘要重领返回原 id。
- GET /ledger：按（发送尝试，最终收件人）合并的台账。

前四项是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。收件记录当前只包含单件 raw 对象，不代表关联资料已完整。

## 通知解释与台账口径

- 逐收件人保存 Action（delayed/failed/delivered/relayed/expanded 原样）、Status 增强状态码、Diagnostic-Code 原文与 Original/Final-Recipient；不从自然语言诊断推断永久地址状态，一封失败通知只落在对应收件人，不波及原信其他地址。
- 原信线索（Original-Envelope-Id、转发原信的 Message-ID、原始收件人）共同核对来源 /attempts 的发送尝试；线索不足为 unmatched、相互矛盾或多候选为 ambiguous，不挑第一个候选。
- 原始与最终收件人不一致、收件人不在尝试清单、同一通知动作自相矛盾等情况保留在 doubts，不据此推断邮箱永久无效。
- 台账中 confirmed 是已确认终态事实；较晚到达的 delayed 只进 observations，不覆盖已确认的失败；终态相互矛盾时保留先确认的事实并记录 conflicting-actions。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs，通知解释、尝试核对与台账合并在 test/notice.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t delivery-notices:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
