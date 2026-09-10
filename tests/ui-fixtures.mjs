export async function openNodeImport(page) {
  const text = page.getByRole("textbox", {
    name: "订阅链接或配置",
    exact: true,
  });
  if (!(await text.isVisible())) {
    if (!(await page.getByRole("dialog").isVisible()))
      await page
        .getByRole("button", { name: /导入资源/ })
        .first()
        .click();
    await page.getByRole("button", { name: "配置文本", exact: true }).click();
  }
  await text.waitFor();
  return text;
}
export async function openRuleEditor(page) {
  const input = page.getByRole("textbox", { name: "匹配内容", exact: true });
  if (!(await input.isVisible()))
    await page
      .getByRole("button", { name: /添加规则/ })
      .first()
      .click();
  await input.waitFor();
  return input;
}
