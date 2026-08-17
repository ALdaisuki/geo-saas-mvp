export const CTRIP_EDITOR_ORIGIN = "https://we.ctrip.com";
export const CTRIP_EDITOR_PATH = "/publish/publishPictureText";

export const CTRIP_TITLE_EDITOR_SELECTOR =
  '[contenteditable="true"][role="textbox"].public-DraftEditor-content';
export const CTRIP_BODY_EDITOR_SELECTOR =
  '[contenteditable="true"][role="combobox"].public-DraftEditor-content';
export const CTRIP_IMAGE_INPUT_SELECTOR = 'input[type="file"][accept="image/*"]';
export const CTRIP_ACTION_SELECTOR = 'button, [role="button"]';

export const CTRIP_UPLOAD_ACTION_LABEL = "上传图片";
export const CTRIP_DRAFT_ACTION_LABEL = "存草稿";
export const CTRIP_PUBLISH_ACTION_LABEL = "发 布";

export const CTRIP_EDITOR_CONTROL_PROBES = Object.freeze([
  Object.freeze({
    id: "title_editor",
    selector: CTRIP_TITLE_EDITOR_SELECTOR,
    readText: false,
    visibility: "visible" as const,
  }),
  Object.freeze({
    id: "body_editor",
    selector: CTRIP_BODY_EDITOR_SELECTOR,
    readText: false,
    visibility: "visible" as const,
  }),
  Object.freeze({
    id: "image_input",
    selector: CTRIP_IMAGE_INPUT_SELECTOR,
    readText: false,
    visibility: "attached" as const,
  }),
  Object.freeze({
    id: "action",
    selector: CTRIP_ACTION_SELECTOR,
    readText: true,
    visibility: "visible" as const,
  }),
]);
