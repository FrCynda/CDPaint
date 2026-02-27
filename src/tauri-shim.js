// Minimal Tauri bridge for projects that disable `withGlobalTauri`.
// It exposes only the APIs this app currently uses.
(function () {
  if (window.__TAURI__) return;

  const internal = window.__TAURI_INTERNALS__;
  if (!internal || typeof internal.invoke !== "function") return;

  const invoke = (cmd, args = {}, options) => internal.invoke(cmd, args, options);

  async function invokeDialog(command, options = {}) {
    try {
      return await invoke(command, { options });
    } catch (_) {
      return invoke(command, options);
    }
  }

  function toEventTarget(target) {
    if (!target) return { kind: "Any" };
    if (typeof target === "string") return { kind: "AnyLabel", label: target };
    return target;
  }

  async function listen(event, handler, options = {}) {
    const callbackId = internal.transformCallback((payload) => handler(payload));
    const eventId = await invoke("plugin:event|listen", {
      event,
      target: toEventTarget(options.target),
      handler: callbackId
    });
    return async () => {
      try {
        if (window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener) {
          window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId);
        }
      } catch (_) {}
      await invoke("plugin:event|unlisten", { event, eventId });
    };
  }

  function currentWindowLabel() {
    return (
      internal.metadata?.currentWindow?.label ||
      internal.metadata?.currentWebview?.windowLabel ||
      "main"
    );
  }

  function makeWindow(label) {
    const call = (command, extra = {}) => invoke(`plugin:window|${command}`, { label, ...extra });
    return {
      label,
      minimize: () => call("minimize"),
      maximize: () => call("maximize"),
      unmaximize: () => call("unmaximize"),
      toggleMaximize: () => call("toggle_maximize"),
      isMaximized: () => call("is_maximized"),
      close: () => call("close"),
      destroy: () => call("destroy"),
      onCloseRequested: async (handler) =>
        listen("tauri://close-requested", async (event) => {
          let prevented = false;
          const wrapped = {
            ...event,
            preventDefault: () => {
              prevented = true;
            }
          };
          await handler(wrapped);
          if (!prevented) {
            await call("destroy");
          }
        }, { target: { kind: "Window", label } })
    };
  }

  const windowApi = {
    getCurrentWindow: () => makeWindow(currentWindowLabel())
  };
  windowApi.appWindow = windowApi.getCurrentWindow();

  window.__TAURI__ = {
    core: {
      invoke,
      convertFileSrc: (path, protocol = "asset") => {
        if (typeof internal.convertFileSrc === "function") {
          return internal.convertFileSrc(path, protocol);
        }
        const encoded = encodeURIComponent(path);
        return `${protocol}://localhost/${encoded}`;
      }
    },
    event: {
      listen
    },
    dialog: {
      open: async (options = {}) => invokeDialog("plugin:dialog|open", options),
      save: async (options = {}) => invokeDialog("plugin:dialog|save", options)
    },
    window: windowApi
  };
})();
