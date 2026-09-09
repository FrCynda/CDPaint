/* Creates the single PaintEngine instance.
 *
 * Split out of paint-engine.js so that prototype-mixin files can load in
 * between: the constructor calls init(), so the engine must not be built
 * until every method it might reach has been assigned. Loads last of the
 * engine scripts, before layer-system.js installs itself onto PaintApp.
 */
    // boot the app (keep this last)
    var PaintApp = new PaintEngine();

    // Clean up timers and workers on page unload
    window.addEventListener('beforeunload', () => {
        try { if (PaintApp.saveReminderTimer) clearInterval(PaintApp.saveReminderTimer); } catch(e) {}
        try { if (PaintApp.saveReminderTick)  clearInterval(PaintApp.saveReminderTick);  } catch(e) {}
        try { if (PaintApp._saveReminderFlash) clearTimeout(PaintApp._saveReminderFlash); } catch(e) {}
        try { if (PaintApp._saveReminderCheck) clearInterval(PaintApp._saveReminderCheck); } catch(e) {}
        try { if (PaintApp.hueSatWorker) PaintApp.hueSatWorker.terminate(); } catch(e) {}
    });
