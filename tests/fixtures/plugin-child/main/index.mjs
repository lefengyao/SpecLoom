let activated = false;
export async function activate(context) {
  activated = true;
  context.commands.register("echo", async (input) => ({ echo: input, activated }));
  context.commands.register("storage", async () => {
    await context.storage.set("hello", "world");
    return await context.storage.get("hello");
  });
  context.commands.register("fail", async () => { throw new Error("fixture failure"); });
}
export async function deactivate() { activated = false; }
