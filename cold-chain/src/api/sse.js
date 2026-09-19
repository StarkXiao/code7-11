// SSE 实时推送中心：任何订阅了事件日志的进程内消费者都能收到追加事件
export class SseHub {
  constructor(store) {
    this.clients = new Set();
    store.subscribe((event) => this.broadcast(event));
  }

  broadcast(event) {
    const data = `event: event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(data);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  add(res) {
    this.clients.add(res);
    res.write(': connected\n\n');
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 25000);
    reqSocketClose(res, () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }
}

function reqSocketClose(res, fn) {
  res.on('close', fn);
}
