export default defineNuxtPlugin(async (app) => {
  await Promise.resolve();
  app.$router.addRoute({
    path: "/late",
    name: "late",
    component: { render: () => null },
  });
});
