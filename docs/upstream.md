# 来源约定

## 产品交换范围

接收 RFC 3464 delivery-status 子集：multipart/report 的 message/delivery-status part，以及单独 message/delivery-status。第一块是报告字段，其后每个空行分块对应一个收件人；折行头须展开，重复头仍保留。multipart 中 text/plain 与 message/rfc822 内的同名词不属于 DSN。Action 的 delayed/failed/delivered/relayed/expanded 原样保存，Status 保留增强状态码，不从自然语言 Diagnostic-Code 推断永久地址状态。Original-Envelope-Id、原信 Message-ID 和原始收件人共同提供候选尝试关联，字段不足或冲突可标为 ambiguous/unmatched，不能挑第一个候选。/attempts 提供发送尝试，/delayed 是同一尝试晚到的通知，不应抹掉已确认的失败事实。

## 当前来源路由

- `/primary`：message/rfc822
- `/attempts`：application/json
- `/delayed`：message/rfc822

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://www.rfc-editor.org/rfc/rfc3464

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
