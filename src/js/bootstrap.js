    // boot the app (keep this last)
    const PaintApp = new PaintEngine();

    // Clean up timers and workers on page unload
    window.addEventListener('beforeunload', () => {
        try { if (PaintApp.saveReminderTimer) clearInterval(PaintApp.saveReminderTimer); } catch(e) {}
        try { if (PaintApp.saveReminderTick)  clearInterval(PaintApp.saveReminderTick);  } catch(e) {}
        try { if (PaintApp._saveReminderFlash) clearTimeout(PaintApp._saveReminderFlash); } catch(e) {}
        try { if (PaintApp._saveReminderCheck) clearInterval(PaintApp._saveReminderCheck); } catch(e) {}
        try { if (PaintApp.hueSatWorker) PaintApp.hueSatWorker.terminate(); } catch(e) {}
    });