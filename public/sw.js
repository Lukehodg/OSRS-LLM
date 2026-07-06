/* RuneScribe service worker — exists only to surface GE price-alert pushes.
   No fetch handler on purpose: the app itself stays fully online-served. */

self.addEventListener("push", (event) => {
  let data = { title: "RuneScribe", body: "GE alert" };
  try { data = event.data.json(); } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || "RuneScribe", {
      body: data.body || "",
      icon: undefined,
      tag: "runescribe-ge-alert",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return clients.openWindow("/");
    })
  );
});
