// Google 表單直送設定。
//
// 1. formResponseUrl 使用已發布表單的 /d/e/.../formResponse 網址。
// 2. 在表單預填連結中找出各題的 entry.數字，填入對應欄位。
// 3. Google 表單必須允許匿名填答，否則跨來源 formResponse 無法可靠送達。
//
// 未完成必要設定時，PDF 工坊仍會顯示回報介面，但不會送出資料。
export const PDF_WORKSHOP_VERSION = "2026.07.18.1";

export const FEEDBACK_FORM_CONFIG = Object.freeze({
  enabled: true,
  disabledReason: "",
  editorFormId: "1A_X2e5eDtFJrqSoTJd_NvdRvKd-hBSDn_YY9dM2vZHU",
  publicFormId: "1FAIpQLScsMeGRjf95fx2Ty_pz1UopatzsOJP8jLJSiBaTvDz4uhiEgg",
  formResponseUrl:
    "https://docs.google.com/forms/d/e/1FAIpQLScsMeGRjf95fx2Ty_pz1UopatzsOJP8jLJSiBaTvDz4uhiEgg/formResponse",
  appScriptProjectId:
    "11a_56lD1Mq_TYXOugiTJO6Y7U2dydR4mN7V8-qfoO_3t9dpT1UFPukTS",
  entries: Object.freeze({
    category: "entry.68606997",
    title: "entry.2099039515",
    description: "entry.1376897564",
    contact: "entry.1240820199",
    environment: "entry.1015219344",
    diagnostics: "entry.1980274205",
  }),
});
