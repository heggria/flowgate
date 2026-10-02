const message = document.getElementById("message");
const result = document.getElementById("result");
const buttons = [...document.querySelectorAll("button")];
const describe = (error) =>
  String(error?.message ?? error)
    .replace(
      /\b(?:https?|socks5?|ss|vmess|vless|trojan):\/\/[^\s<>"']+/gi,
      "[地址已隐藏]",
    )
    .slice(0, 1600);
async function act(method, success) {
  buttons.forEach((button) => {
    button.disabled = true;
  });
  result.textContent = "正在处理，请稍候…";
  try {
    await window.shell.request(method);
    result.textContent = success;
  } catch (error) {
    result.textContent = `操作未完成：${describe(error)}。请检查上方原因，修复后再重试。`;
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}
window.shell
  .request("recovery.status")
  .then((state) => {
    message.textContent = describe(state.message);
  })
  .catch((error) => {
    message.textContent = `无法读取恢复状态：${describe(error)}`;
  });
document.getElementById("disconnect").onclick = () =>
  act("recovery.disconnect", "已请求清理本应用连接，请核实网络状态。");
document.getElementById("restore").onclick = () =>
  act("recovery.restore", "已恢复内置版本，正在重新加载。");
