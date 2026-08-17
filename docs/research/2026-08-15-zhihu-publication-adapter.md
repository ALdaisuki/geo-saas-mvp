# 知乎文章发布适配调研与接入方案

日期：2026-08-15  
范围：知乎专栏文章（第一阶段），不包含回答、想法和真实外发。  
状态：`reference_only`，尚未进入生产连接器。

## 结论

知乎第一阶段应优先走知乎官方 OpenAPI，浏览器创作者中心只作为没有可用 OpenAPI 凭证时的受控降级路径。不要直接复制现有平台的“写入 DOM、点击发布、跳转即成功”模式：知乎官方发布链路已经提供了结构化校验、预览、签名请求、内容 token 和公开文章 URL，适合做幂等、审计和异步回读。

推荐的接入顺序：

1. 先实现知乎文章的 `session_probe`、内容校验和图片媒体准备。
2. 再实现 `final_submit`，只把 OpenAPI 响应记为 `accepted`，不能直接记为公开发布。
3. 接入创作者/内容管理状态回读，把 `draft`、`pending`、`rejected`、`published` 分开。
4. 只有后台状态为已发布且公开 URL 回读通过标题、作者和正文唯一标记校验时，才记为 `confirmed`。
5. 浏览器降级适配必须独立版本化，且同一账号保持单写入；不同账号可以并行，但受宿主总并发和 CPU 水位门限制。

## 调研来源

### 知乎官方 GitHub

- `https://github.com/zhihu/ZhihuPublisher`
  - 固定版本：`97ca4224fc3d45033a1b8dc11a9d7e622a611295`（2026-08-11，`Update public release`）。
  - `SKILL.md` 的技能许可字段为 MIT；GitHub 仓库元数据没有提供可直接采信的 SPDX 许可证，生产接入前仍需按仓库当前许可文件复核。
  - 能力：文章、提问、想法的 draft -> validate -> preview -> user confirmation -> publish 编排。
  - 文章发布入口：`POST https://openapi.zhihu.com/openapi/publish`。
  - 文章响应成功时返回 `data.content_token` 和 `data.url`；HTTP 200 本身不能作为发布成功依据。
  - 文章发布前需要用户确认预览；这条交互规则不能直接照搬到无人值守批次，GEO 应将已审计的 variant grant 作为等价的确认凭据。

- `https://github.com/zhihu/zhihu-mediacloud-uploader`
  - 负责图片转存、格式/尺寸校验和媒体上传结果，返回发布所需的媒体标识。
  - 第一阶段只允许图片；视频或其他文件类型必须在媒体阶段直接阻断。

### 成熟的第三方实现

- `https://github.com/wechatsync/Wechatsync`
  - 版本线：`v2`；许可：GPL-3.0。
  - `packages/core/src/adapters/platforms/zhihu.ts` 展示了账号探针、草稿创建、草稿更新、HTML 适配、图片 URL/二进制上传和图片处理等待。
  - 可复用思路：统一 runtime 抽象、图片 hash 去重、图片处理状态轮询、错误结果结构化。
  - 不可直接复用：未提供 GEO 所需的独立审核回读、公开 URL 确认和账号级幂等审计；其中部分接口属于知乎站内接口，不能作为第一版生产协议的唯一依据。

- `https://github.com/leaperone/MultiPost-Extension`
  - 许可：Apache-2.0。
  - 固定参考提交：`4d9714a1f9132eadc7071b3977e9b4acf76d7c28`。
  - `src/sync/article/zhihu.ts` 覆盖创作者中心标题、正文、封面文件控件和发布按钮定位；`src/contents/scraper/zhihu.ts` 覆盖公开页面的标题、作者、封面和正文抓取。
  - 可复用思路：MutationObserver 等待动态编辑器、通过真实粘贴事件写入富文本、独立处理封面文件、公开页用 `og:title`/作者/正文定位。
  - 不可直接复用：点击“发布”后没有独立的后台审核状态和公开 URL 证明，不能把 `click` 返回当作 accepted 或 confirmed。

- `https://github.com/jackwener/OpenCLI`
  - 许可：Apache-2.0；当前仓库有成熟的浏览器桥接和大量知乎 JavaScript 命令。
  - `clis/zhihu/auth.js` 提供 `z_c0` cookie 快速检查，再调用 `/api/v4/me?include=url_token` 校验当前账号身份。
  - `clis/zhihu/write-shared.js` 提供安全的当前用户 slug 解析、`--execute` 写操作门禁和 payload 校验。
  - 但其知乎写入命令主要覆盖回答、评论、点赞、收藏等动作，不是知乎专栏文章发布器；`docs/adapters/browser/zhihu.md` 也没有文章创建命令。因此只能复用身份探针、浏览器桥接和写操作门禁，不能当作文章发布适配器。

## 官方 OpenAPI 契约（待接入时冻结）

### 鉴权

官方 skill 文档要求：

- `ZHIHU_OPENAPI_APP_KEY`：知乎用户 Token（个人主页 URL 的用户标识）。
- `ZHIHU_OPENAPI_APP_SECRET`：知乎开放平台访问密钥，用于 HMAC-SHA256 签名。
- 请求头包含 `X-App-Key`、`X-Timestamp`、`X-Log-Id`、`X-Extra-Info`、`X-Sign`。
- Secret 不能进入数据库明文、请求文件、日志、审计载荷或聊天记录。

GEO 不应把这一套凭证写入全局环境并让所有账号共享。生产模型应增加账号级加密凭证引用，运行时短暂解密，使用后清理；在没有账号级凭证存储与轮换能力前，不得宣称支持知乎 OpenAPI 多账号外发。

### 文章请求

请求体的最小结构：

```json
{
  "type": "article",
  "confirmed": true,
  "confirm_note": "confirmed by audited GEO variant",
  "content": {
    "title": "...",
    "html": "<p>...</p>",
    "comment_permission": "all",
    "table_of_contents_enabled": false
  }
}
```

约束：

- `title` 和 `html` 必须来自同一份已审计 variant；不能从预览 HTML 反向提取。
- 话题最多三个，必须由用户提供知乎话题链接；第一阶段不自动推断或创建话题。
- 如果正文由 AI 生成或改写，应把 `ai_creation` 作为推荐的创作声明选项交给业务配置决定，不应通过改写或隐藏声明来规避平台识别。
- 官方文章规范没有给出独立 `cover` 请求字段；第一阶段先把正文图片作为媒体处理，封面是否需要额外的创作者中心动作必须通过真实页面取证后再单独建能力，不得臆造接口。

### 结果判定

- HTTP 失败：`submit_failed`。
- 非法 JSON 或缺少 `status`：`submit_uncertain`，禁止自动重试最终提交。
- JSON `status == 0`：`accepted`，记录 `content_token`/候选 URL，但仍需后台和公开回读。
- JSON `status != 0`：`rejected`，保留去敏错误码和消息。

候选 URL 必须经过：

1. 后台记录的远端内容标识绑定；
2. URL host/path 允许列表校验；
3. 账号身份、标题归一化匹配和正文唯一标记匹配。

## 浏览器降级路径

### 现场只读取证（2026-08-15）

对 `https://zhuanlan.zhihu.com/write` 做了只读导航和 DOM 快照。当前会话实际返回知乎登录页，页面包含“验证码登录”“密码登录”和手机号输入框，没有标题编辑器、正文编辑器或发布按钮。因此本次没有冻结新的真实 DOM 选择器，也没有登录、上传、点击发布或修改任何账号状态；知乎适配继续按 fail-closed 处理，直到提供已登录且明确授权的只读取证会话。

仅当账号没有 OpenAPI 凭证，或业务明确选择浏览器路径时启用 `zhihu-browser-publication-v1`。实现边界：

- 登录态：优先使用知乎身份接口或页面内稳定身份字段，不能只凭 URL 判断登录。
- 编辑器：动态等待标题输入框和正文编辑器，写入后重新读取 DOM 验证；编辑器被重建时重新绑定，不复用失效节点。
- 图片：优先使用官方媒体上传依赖；只有在媒体接口不可用且页面明确提供文件控件时，才取证 `input[type=file]` 的归属和重建行为。
- 提交：只点击一次官方最终提交控件，监听页面/API 响应；出现验证码、二次确认、风控提示或页面空白时转 `awaiting_manual_review`，不猜成功。
- 回读：先创作者后台，再公开 URL；草稿、待审核、未通过均不能算已发布。
- 生命周期：提交证据落库后销毁账号浏览器 runtime；销毁必须幂等，重复标签页和残留 context 计入失败诊断。

## GEO 状态机映射

```text
variant_ready
  -> prepared
  -> submit_accepted
  -> pending_review
  -> published_candidate
  -> confirmed
```

异常分支：

- `draft_only`：平台只保存草稿或提交按钮未被接受，返回 `not_accepted`。
- `submit_uncertain`：最终点击后网络/页面超时，禁止自动重试；等待人工或后台查询。
- `publisher_rejected`：平台明确拒绝，记录平台消息，不升级为适配器漂移。
- `adapter_drift`：选择器、接口响应结构或页面归属与冻结契约不一致，暂停该平台账号，不影响其他平台。
- `public_readback_deferred`：后台已接受但公开页暂不可用，保持 `pending`，不能改写成失败。

## 并发与资源策略

- 同一知乎账号：同一时间最多一个写入任务；回读可以在独立低优先级队列中串行。
- 不同知乎账号：允许并行，按账号级租约分配。
- 宿主层：继续使用浏览器宿主总并发上限和 CPU 水位门；达到阈值时暂缓领取，不让 context 因争抢资源崩溃。
- OpenAPI 路径优先于浏览器路径，避免为同一账号额外启动 runtime。
- 最终提交不自动重试；仅允许对登录探针、媒体上传和后台回读执行有上限的受控重试。

## 适配器注册前置条件

以下条件全部满足前，知乎只能保持 `reference_only`：

1. `zhihu` 加入 contract/schema，并明确第一阶段仅为 `article`。
2. 账号级 OpenAPI 凭证或浏览器账号运行时的安全引用已经具备。
3. `session_probe`、媒体上传、草稿/准备阶段单测通过。
4. `final_submit` 有去敏响应 fixture 和幂等测试。
5. 后台审核状态映射有真实登录账号取证；没有“提交成功即已发布”的快捷判断。
6. 公开回读能绑定账号、标题、正文唯一标记和 canonical URL。
7. 账号 runtime 提交后销毁、异常清理和重复标签页回收测试通过。
8. 现有生产平台批次隔离验证：知乎治理门或漂移不会阻断其他平台槽位。

## 验收矩阵

| 场景                         | 预期结果                                          |
| ---------------------------- | ------------------------------------------------- |
| 未登录                       | `AUTH_REQUIRED`，不创建草稿、不提交               |
| 无 OpenAPI 凭证              | 明确降级到浏览器路径或保持不可用，不伪造 API 成功 |
| 图片上传失败                 | 媒体阶段失败，不能进入最终提交                    |
| 编辑器重建                   | 重新定位并回读，旧节点不继续使用                  |
| 首次提交返回成功             | 仅 `accepted`，等待后台状态                       |
| 后台显示草稿                 | `not_accepted`                                    |
| 后台显示审核中               | `pending_review`                                  |
| 后台显示未通过               | `publisher_rejected`                              |
| 后台显示已发布但公开页不可用 | `public_readback_deferred`                        |
| 公开页标题/正文标记通过      | `confirmed` 并落公开 URL                          |
| 提交后浏览器未销毁           | 运行时清理测试失败，不能通过验收                  |
| 同账号并发写入               | 第二任务被账号租约阻止，不创建第二个写入 context  |
| 不同账号并行                 | 可并行，受宿主 CPU/浏览器总并发门限制             |

## 下一步

1. 用户确认本文方案后，把 `sp-stage` 从 `research` 推进到 `to-spec`。
2. 先实现 contract、账号凭证引用和 OpenAPI dry-run/fixture 测试，不接真实发布。
3. 再实现浏览器降级适配与真实 DOM 只读取证。
4. 通过一篇明确标记的人工验收文章完成后台与公开回读校准后，才考虑加入生产平台池。
