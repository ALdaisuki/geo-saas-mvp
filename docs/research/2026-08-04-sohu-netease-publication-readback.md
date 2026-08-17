# 搜狐号与网易号发布、审核和公开回读契约

日期：2026-08-04

## 结论

搜狐号与网易号都可以复用成熟开源实现完成登录识别、标题/正文写入和最终发布按钮定位，但不能复用上游项目的“点击后跳转即成功”判断。GEO 必须把一次发布拆成：

1. 固定官方写稿页写入并回读标题、正文；
2. 最终提交只执行一次，平台响应只记录为 `accepted`、`uncertain` 或 `rejected`；
3. 在内容管理后台轮询审核状态并绑定远端文章 ID；
4. 只有后台进入已发布状态后，才在独立公开页核对账号、标题和正文标记；
5. 公开页完全匹配后才记录 `confirmed`。

当前实现固定在：

- `apps/ctrip-bridge/src/playwright-sohu-publication.ts`
- `apps/ctrip-bridge/src/playwright-netease-publication.ts`
- `apps/ctrip-bridge/src/playwright-platform-publication.ts`

## 采用的开源实现

### 搜狐号

- `doocs/cose@e70fa9e92a71cd2f10e0c883981f324a332162d4` 固定了当前写稿入口 `https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1`。[源码](https://github.com/doocs/cose/blob/e70fa9e92a71cd2f10e0c883981f324a332162d4/packages/core/src/platforms/sohu.js#L1-L10)
- `leaperone/MultiPost-Extension@4d9714a1f9132eadc7071b3977e9b4acf76d7c28` 提供标题控件、Quill 正文、封面和发布按钮定位。[标题与正文](https://github.com/leaperone/MultiPost-Extension/blob/4d9714a1f9132eadc7071b3977e9b4acf76d7c28/src/sync/article/sohu.ts#L111-L145)
- `wechatsync/Wechatsync@a98e42865387285afcc027c61836488748f3b30f` 提供账号列表、草稿 payload 和图片上传实现。它默认选择第一个子账号，这一点不能复用；GEO 必须绑定明确的 `accountId`。[账号识别](https://github.com/wechatsync/Wechatsync/blob/a98e42865387285afcc027c61836488748f3b30f/packages/core/src/adapters/platforms/sohu.ts#L59-L115) [草稿 payload](https://github.com/wechatsync/Wechatsync/blob/a98e42865387285afcc027c61836488748f3b30f/packages/core/src/adapters/platforms/sohu.ts#L146-L230) [图片上传](https://github.com/wechatsync/Wechatsync/blob/a98e42865387285afcc027c61836488748f3b30f/packages/core/src/adapters/platforms/sohu.ts#L237-L278)
- `leaperone/MultiPost-Extension@4d9714a1f9132eadc7071b3977e9b4acf76d7c28` 的公开页 scraper 固定了 `meta[property="og:title"]`、`a.author-name`、`div.content-main-detail` 和 `article`。[公开页 scraper](https://github.com/leaperone/MultiPost-Extension/blob/4d9714a1f9132eadc7071b3977e9b4acf76d7c28/src/contents/scraper/sohu.ts)
- `yuvenhol/dataharvest@20649d4270e32ddf6fcd6b67da25d0b4d44cbd55` 提供第二组公开页回读证据：`div.text-title > h1`、`article#mp-editor`，以及 `https://www.sohu.com/a/{articleId}_{userId}` 样例。[Sohu purifier](https://github.com/yuvenhol/dataharvest/blob/20649d4270e32ddf6fcd6b67da25d0b4d44cbd55/src/dataharvest/purifier/sohu_purifier.py) [固定样例](https://github.com/yuvenhol/dataharvest/blob/20649d4270e32ddf6fcd6b67da25d0b4d44cbd55/tests/test_purifiter.py)

### 网易号

- `doocs/cose@e70fa9e92a71cd2f10e0c883981f324a332162d4` 通过 `navinfo.do` 要求 `code === 1` 且存在 `wemediaId`，可作为登录身份探针；其 cookie 收集方式不复用。[源码](https://github.com/doocs/cose/blob/e70fa9e92a71cd2f10e0c883981f324a332162d4/packages/detection/src/platforms/wangyihao.js#L10-L50)
- `RyanYipeng/SyncCaster@ddad3c27e3f6a18537a72bc81a7b7bf9075e6efe` 固定写稿入口 `https://mp.163.com/#/article-publish`，并实现 Draft.js 候选评分、HTML paste 和正文图片处理，但明确不执行最终发布。[适配器说明](https://github.com/RyanYipeng/SyncCaster/blob/ddad3c27e3f6a18537a72bc81a7b7bf9075e6efe/packages/adapters/src/wangyihao.ts#L81-L115) [写稿入口](https://github.com/RyanYipeng/SyncCaster/blob/ddad3c27e3f6a18537a72bc81a7b7bf9075e6efe/packages/adapters/src/wangyihao.ts#L155-L166) [Draft.js 选择器](https://github.com/RyanYipeng/SyncCaster/blob/ddad3c27e3f6a18537a72bc81a7b7bf9075e6efe/packages/adapters/src/wangyihao.ts#L628-L681)
- `leaperone/MultiPost-Extension@4d9714a1f9132eadc7071b3977e9b4acf76d7c28` 补充了当前 5 到 64 字标题占位符、`data-contents` paste、自动封面和发布按钮定位。[源码](https://github.com/leaperone/MultiPost-Extension/blob/4d9714a1f9132eadc7071b3977e9b4acf76d7c28/src/sync/article/netease.ts#L48-L99)
- `WeiEast/python_exercise@4eecb0bb93d83f3646456a84de07b06f109a7d60` 的 `fetch_article_status` 固定了 `navinfo.do` 身份读取、`POST /wemedia/content/manage/list.do`、按标题筛选、`contentState` 和 `articleId` 读取。该实现较旧，GEO 只复用查询结构和字段，不复用 HTTP、Cookie 登录、验证码重试、`contentType=4` 或旧 `dy.163.com` 公开 URL。[源码](https://github.com/WeiEast/python_exercise/blob/4eecb0bb93d83f3646456a84de07b06f109a7d60/spiders/wangyi.py)
- `leaperone/MultiPost-Extension@4d9714a1f9132eadc7071b3977e9b4acf76d7c28` 的公开页 scraper 固定了 `h1.post_title`、`.post_info > a` 和 `div.post_body`。[公开页 scraper](https://github.com/leaperone/MultiPost-Extension/blob/4d9714a1f9132eadc7071b3977e9b4acf76d7c28/src/contents/scraper/netease.ts)
- `yuvenhol/dataharvest@20649d4270e32ddf6fcd6b67da25d0b4d44cbd55` 独立提供 `h1.post_title`、`div.post_body` 和网易公开文章 URL 的回归样例。[NetEase purifier](https://github.com/yuvenhol/dataharvest/blob/20649d4270e32ddf6fcd6b67da25d0b4d44cbd55/src/dataharvest/purifier/wangyi_purifier.py) [固定样例](https://github.com/yuvenhol/dataharvest/blob/20649d4270e32ddf6fcd6b67da25d0b4d44cbd55/tests/test_purifiter.py)

### 来源覆盖结论

| 平台 | 登录探针 | 写稿/最终按钮 | 审核回读                 | 公开页回读 |
| ---- | -------- | ------------- | ------------------------ | ---------- |
| 搜狐 | 已固定   | 已固定        | **缺少当前 GitHub 实现** | 已固定     |
| 网易 | 已固定   | 已固定        | 已固定                   | 已固定     |

搜狐审核列表的端点和状态表来自 2026-08-04 官方 bundle 侦察，目前只能作为待验证契约，不能在 outbound source manifest 中声称 `moderation_readback` 已由 GitHub 覆盖。首次账号金丝雀可在可见的官方内容管理页人工确认唯一标题和已发布链接；在找到并固定 GitHub 实现前，不应新增绕过 UI 的私有接口调用。

## 搜狐号当前官方契约

2026-08-04 检查的官方微前端为：

`https://g1.itc.cn/bsf-mp-prod/mp_micro_contentmanager/202607231510/dist/js/app.1172f12605.js`

### 写稿与提交

- 标题：`.publish-title input`，当前占位符为 `请输入标题（5-72字）`。
- 正文：Quill `.ql-editor`。
- 图片上传：`POST /commons/front/outerUpload/image/file`。
- 草稿：`POST /mpbp/bp/news/v4/news/draft/v2`。
- 最终提交：`POST /mpbp/bp/news/v4/news/publish/v2`。
- 提交和草稿的核心 payload 都包括 `title`、`content`、`channelId`、`categoryId`、`id`、`cover`、`topicIds` 和 `attrIds`。
- `code === 2000000` 只代表平台接受请求，不能直接记作已发布。返回 `data` 可先作为候选文章 ID，但必须由后台列表再次绑定。

页面最终提交必须点击官方 UI 并观察准确响应。最后一次点击派发后即使浏览器超时，也只能记为 `uncertain`，不得自动重试。

### 审核回读

后台列表接口为：

`GET /mpbp/bp/news/v4/users/news?psize=10&newsType=0&statusType=<状态>`

当前状态映射：

| status | 解释     | GEO 状态                    |
| ------ | -------- | --------------------------- |
| 1      | 草稿     | `draft`                     |
| 2      | 审核中   | `pending`                   |
| 3      | 未通过   | `rejected`                  |
| 4      | 已发布   | `published`                 |
| 5      | 定时发布 | `pending`                   |
| 7      | 已删除   | `deleted`                   |
| 9      | 二审删除 | `deleted`                   |
| 16     | 二审通过 | `pending`，仍等待公开状态 4 |

官方 bundle 只在 `status === 4` 时生成公开 URL：

`https://www.sohu.com/a/{articleId}_{userId}`

因此 `articleId` 和 `userId` 必须同时来自同一条后台记录。提交响应中的单个文章 ID 不足以构造可信公开 URL。

### 公开回读

已验证公开样本：

`https://www.sohu.com/a/1058220115_100136517`

当前稳定信号：

- 页面身份：`body[data-newsid]`、canonical link；
- 标题：`.title-info-title`；
- 正文：`article#mp-editor`；
- 作者：`#user-info h1 a`；
- 媒体身份：`meta[name="mediaid"]`。

确认必须同时满足 URL 中的 `articleId`、`userId`、预期账号名、归一化标题和本次唯一正文标记。后台“已发布”本身仍不等于公开回读成功。

### 挑战

业务码 `9000000` 会触发 TencentCaptcha，页面随后调用 `/mpbp/bp/captcha/slide/check`。检测到可见验证码 iframe 或容器时暂停，交给用户完成，不自动绕过。

## 网易号当前官方契约

2026-08-04 检查的官方 bundle 为：

`https://static.ws.126.net/163/mp/college/static/js/main.52235f39.chunk.js`

### 写稿与提交

- 写稿入口：`https://mp.163.com/#/article-publish`。
- 标题：当前占位符 `请输入标题 (5~64个字)`。
- 正文：Draft.js；优先使用 `.public-DraftEditor-content[contenteditable="true"]`，通过 paste 写入简化 HTML。
- 最终提交：`POST /article/status/api/publishV2.do`。
- Content-Type：`application/x-www-form-urlencoded; charset=utf-8`。
- 核心字段：`wemediaId`、`articleId`、`title`、`content`、`cover`、`operation`、`scheduled`。
- 新文章使用 `articleId=-1`、`operation=publish`、`scheduled=0`。

官方页面提交前会取安全 token 并作为 `ursToken`，因此首次接入点击官方 UI、监听响应，不自行构造请求。页面把 `code === 1` 显示为发布成功，但 GEO 仍只记录为 `accepted`。

### 审核回读

当前内容列表接口为：

`POST /content/manage/list.do`

官方 bundle 对图文记录使用 `contentType === 1`，并且仅在 `contentState === 3` 时打开外部文章 URL：

`https://www.163.com/dy/article/{articleId}.html`

因此当前实现只把 `contentType === 1 && contentState === 3` 解释为可公开候选；其他数字状态暂记为 `pending_or_unpublished`。首次登录金丝雀必须保存去敏后的列表字段样本，再冻结完整状态映射。

旧实现使用的 `https://dy.163.com/v2/article/detail/{articleId}.html` 不再作为生产允许 URL。

### 公开回读

只允许 `https://www.163.com/dy/article/{ARTICLE_ID}.html`。公开页需要核对：

- URL 中的 `articleId` 与后台记录一致；
- 可见作者名与登录账号一致；
- 标题完全归一化匹配；
- 正文包含本次唯一标记。

当前候选 DOM 为标题 `h1.post_title`、正文 `#content`/`.post_body`、作者 `.post_info .source`。首次真实公开页必须校准并冻结这些选择器。

### 挑战

网易号加载网易易盾。错误码 `100502`、`100503` 会展示验证码，完成人工验证后页面带 `NECaptchaValidate` 再提交。检测到可见易盾元素时暂停，不自动重试最终提交。

## 首次金丝雀证据

每个平台首篇文章使用不同的唯一标记，并保存以下去敏证据：

- 平台、账号 ID、账号显示名、adapter version；
- 本地 variant ID、标题、正文哈希、唯一标记；
- 最终点击时间、精确提交端点、响应业务码、候选远端 ID；
- 后台列表轮询时间、远端 ID、账号 ID、审核状态；
- 公开 URL、canonical URL、可见作者、标题、正文标记匹配结果；
- 最终结论只能是 `confirmed`、`rejected`、`pending` 或 `uncertain`。

不得保存 cookie、密码、验证码、安全 token 或完整响应正文。挑战页交给用户，最终提交不确定时不自动重发。
