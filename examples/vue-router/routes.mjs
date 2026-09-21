export async function configure(router) {
  const view = { render: () => null };
  router.addRoute({
    path: "/catalog",
    name: "catalog",
    component: view,
    meta: { audience: "public" },
    children: [
      { path: "", name: "catalog-index", component: view },
      {
        path: ":item",
        name: "catalog-item",
        component: view,
        alias: "entry/:item",
      },
    ],
  });
  await Promise.resolve();
  router.addRoute({ path: "/about", name: "about", component: view });
}
