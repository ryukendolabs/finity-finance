// Finity alert notifications (Web Push). Shows each alert and opens the app on click.
self.addEventListener("push", (event) => {
  let data = { title: "Finity", body: "", url: "/app/alerts" };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* plain-text push: keep the defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, { body: data.body, icon: "/icon.png", badge: "/icon.png", data: { url: data.url } }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/app/alerts", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => w.url === url);
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
