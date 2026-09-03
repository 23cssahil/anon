self.addEventListener('push', function(event) {
    if (event.data) {
        let payload;
        try {
            payload = event.data.json();
        } catch (e) {
            payload = { title: 'Notification', body: event.data.text() };
        }
        
        const title = payload.title || 'Notification';
        const options = {
            body: payload.body,
            icon: '/favicon.ico',
            data: { url: payload.url || '/' },
            vibrate: [200, 100, 200]
        };
        
        event.waitUntil(self.registration.showNotification(title, options));
    }
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    if (event.notification.data && event.notification.data.url) {
        event.waitUntil(clients.openWindow(event.notification.data.url));
    }
});
