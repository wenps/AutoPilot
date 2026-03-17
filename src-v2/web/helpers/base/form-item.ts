/**
 * 表单项容器识别 / Form item container detection.
 *
 * 通过类名尾缀 `form-item` 通配匹配，自动覆盖所有主流 UI 框架
 * （Element Plus `.el-form-item`、Ant Design `.ant-form-item`、TDesign `.t-form-item` 等），
 * 同时兼容 ARIA `role="group"`。
 *
 * 使用 classList.endsWith 而非 CSS `[class*=]`，避免误匹配
 * 子组件类名（如 `.el-form-item__label`、`.ant-form-item-control`）。
 *
 * 被 fill-helpers（搜索范围收集）和 retarget（label→控件重定向）共用。
 */

/** 判断元素是否为表单项容器 */
export function isFormItemContainer(el: Element): boolean {
  const classes = el.classList;
  for (let i = 0; i < classes.length; i++) {
    if (classes[i].endsWith("form-item")) return true;
  }
  return el.getAttribute("role") === "group";
}

/** 从元素向上查找最近的表单项容器 */
export function findFormItemContainer(el: Element): Element | null {
  let cursor: Element | null = el.parentElement;
  while (cursor) {
    if (isFormItemContainer(cursor)) return cursor;
    cursor = cursor.parentElement;
  }
  return null;
}
