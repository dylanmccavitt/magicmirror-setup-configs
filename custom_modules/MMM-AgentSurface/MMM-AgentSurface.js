/* global Module, window */

Module.register("MMM-AgentSurface", {
  defaults: {
    title: "Agent Surface",
    staleAfterMs: 5 * 60 * 1000,
    maxThreads: 8,
    showSummary: true,
    mirrorOs: {}
  },

  start: function () {
    this.snapshot = null;
    this.summary = null;
    this.error = null;
    this.payloadStates = {};
    this.sourceData = {};
    this.rotationTimer = null;
    this.chromeClockTimer = null;
    this.chromeClockTime = null;
    this.chromeClockMeridiem = null;
    this.chromeClockDate = null;
    this.homeClockTime = null;
    this.homeClockMeridiem = null;
    this.shell = window.MMMAgentSurfaceMirrorOsShell
      ? window.MMMAgentSurfaceMirrorOsShell.createMirrorOsShell(this.config.mirrorOs || {})
      : null;
    this.staleTimer = setInterval(function () {
      this.refreshAgentSnapshotState();
      this.refreshSourceStates();
      this.updateDom(0);
    }.bind(this), 60 * 1000);
    this.scheduleRotation();
    this.reportPageState();
    this.sendSocketNotification("MMM_AGENT_SURFACE_GET_CURRENT");
  },

  suspend: function () {
    clearInterval(this.staleTimer);
    this.staleTimer = null;
    this.clearRotationTimer();
    this.clearChromeClockTimer();
  },

  resume: function () {
    if (!this.staleTimer) {
      this.staleTimer = setInterval(function () {
        this.refreshAgentSnapshotState();
        this.refreshSourceStates();
        this.updateDom(0);
      }.bind(this), 60 * 1000);
    }
    this.scheduleRotation();
    this.reportPageState();
    this.restartChromeClock();
    this.updateDom(0);
  },

  getStyles: function () {
    return ["MMM-AgentSurface.css"];
  },

  getScripts: function () {
    return [this.file("display-sanitizer.js"), this.file("mirror-os-shell.js"), this.file("agents-view.js"), this.file("home-view.js")];
  },

  clearRotationTimer: function () {
    clearTimeout(this.rotationTimer);
    this.rotationTimer = null;
  },

  scheduleRotation: function () {
    this.clearRotationTimer();
    if (!this.shell || this.shell.state().rotationPaused) return;

    var dwellMs = this.shell.dwellSeconds(this.shell.currentPage()) * 1000;
    this.rotationTimer = setTimeout(function () {
      if (!this.shell) return;
      this.shell.next("rotation");
      this.reportPageState();
      this.updateDom(300);
      this.scheduleRotation();
    }.bind(this), dwellMs);
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "MMM_AGENT_SURFACE_SNAPSHOT") {
      if (!window.MMMAgentSurfaceDisplaySanitizer) {
        this.snapshot = null;
        this.summary = null;
        this.error = "Display sanitizer unavailable";
        this.payloadStates.agentSnapshot = { state: "error", message: this.error };
        this.updateDom(300);
        return;
      }

      this.error = null;
      this.snapshot = window.MMMAgentSurfaceDisplaySanitizer.sanitizeSnapshotForDisplay(payload && payload.snapshot);
      this.summary = this.snapshot && this.snapshot.summary ? this.snapshot.summary : (payload && payload.summary ? payload.summary : null);
      this.refreshAgentSnapshotState();
      this.updateDom(300);
      return;
    }

    if (notification === "MMM_AGENT_SURFACE_ERROR") {
      this.error = payload && payload.message ? String(payload.message) : "Snapshot unavailable";
      this.payloadStates.agentSnapshot = { state: "error", message: this.error };
      this.updateDom(300);
      return;
    }

    if (notification === "MMM_AGENT_SURFACE_SOURCE_DATA") {
      if (!payload || typeof payload.dataSourceId !== "string") return;
      if (payload.dataSourceId === "agentSnapshot") return;
      this.sourceData[payload.dataSourceId] = payload;
      this.refreshSourceStates();
      this.updateDom(300);
      return;
    }

    if (notification === "MMM_AGENT_SURFACE_CONTROL") {
      this.applyControlCommand(payload);
    }
  },

  notificationReceived: function (notification, payload) {
    if (!this.shell) return;

    if (notification === "MIRROR_OS_PAGE_NEXT") {
      this.applyControlCommand({ command: "next" });
      return;
    }

    if (notification === "MIRROR_OS_PAGE_PREV") {
      this.applyControlCommand({ command: "previous" });
      return;
    }

    if (notification === "MIRROR_OS_PAGE_JUMP") {
      this.applyControlCommand({ command: "show", pageId: payload && payload.pageId });
      return;
    }

    if (notification === "MIRROR_OS_ROTATION_PAUSE") {
      this.applyControlCommand({ command: "pause" });
      return;
    }

    if (notification === "MIRROR_OS_ROTATION_RESUME") {
      this.applyControlCommand({ command: "resume" });
    }
  },

  applyControlCommand: function (payload) {
    if (!this.shell) return;
    var command = payload && payload.command;
    var source = payload && (payload.source === "voice" || payload.source === "remote" || payload.source === "command") ? payload.source : "command";

    if (command === "next") {
      this.shell.next(source);
    } else if (command === "previous") {
      this.shell.prev(source);
    } else if (command === "show") {
      this.shell.jump(payload && payload.pageId, source);
    } else if (command === "pause") {
      this.shell.pause(source);
    } else if (command === "resume") {
      this.shell.resume(source);
    } else {
      return;
    }

    this.reportPageState();
    this.updateDom(0);
    this.scheduleRotation();
  },

  reportPageState: function () {
    if (!this.shell) return;
    var state = this.shell.state();
    state.pages = this.shell.rotationOrder();
    this.sendSocketNotification("MMM_AGENT_SURFACE_PAGE_STATE", state);
  },

  refreshAgentSnapshotState: function () {
    if (this.error) {
      this.payloadStates.agentSnapshot = { state: "error", message: this.error };
      return;
    }

    if (!this.snapshot) {
      delete this.payloadStates.agentSnapshot;
      return;
    }

    var stale = this.isSnapshotStale();
    var source = this.snapshot.source || {};
    var provenance = [source.label, this.formatRelativeAge(this.snapshot.generatedAt)].filter(Boolean).join(" · ");
    this.payloadStates.agentSnapshot = {
      state: stale ? "stale" : "ready",
      stale: stale,
      provenance: provenance || null,
      message: null
    };
  },

  sourceStaleAfterSeconds: function (dataSourceId) {
    var mirrorOs = this.config.mirrorOs || {};
    var dataSources = mirrorOs.dataSources || {};
    var entry = dataSources[dataSourceId] || {};
    var value = Number(entry.staleAfterSeconds);
    return Number.isFinite(value) && value > 0 ? value : 900;
  },

  refreshSourceStates: function () {
    Object.keys(this.sourceData).forEach(function (dataSourceId) {
      var result = this.sourceData[dataSourceId];

      if (result.state === "unconfigured") {
        delete this.payloadStates[dataSourceId];
        return;
      }

      if (result.state === "error") {
        this.payloadStates[dataSourceId] = { state: "error", message: result.message || "Source error." };
        return;
      }

      if (result.state !== "ready") {
        delete this.payloadStates[dataSourceId];
        return;
      }

      var updatedAt = Date.parse(result.updatedAt);
      var stale = Number.isFinite(updatedAt)
        ? Date.now() - updatedAt > this.sourceStaleAfterSeconds(dataSourceId) * 1000
        : true;
      var provenance = [result.source, this.formatRelativeAge(result.updatedAt)].filter(Boolean).join(" · ");
      this.payloadStates[dataSourceId] = {
        state: stale ? "stale" : "ready",
        stale: stale,
        provenance: provenance || null,
        message: stale ? "Data is stale. Last update " + (this.formatRelativeAge(result.updatedAt) || "unknown") + "." : null
      };
    }, this);
  },

  getDom: function () {
    var wrapper = document.createElement("section");
    wrapper.className = "mmm-mirror-os mmm-agent-surface";

    if (!this.shell) {
      wrapper.appendChild(this.renderMessage("error", "Mirror OS shell unavailable."));
      return wrapper;
    }

    this.refreshAgentSnapshotState();
    this.refreshSourceStates();
    var viewModel = this.shell.pageViewModel(this.shell.currentPage(), { payloadStates: this.payloadStates, now: Date.now() });
    if (!viewModel) viewModel = this.shell.pageViewModel("home", { payloadStates: this.payloadStates, now: Date.now() });
    this.homeClockTime = null;
    this.homeClockMeridiem = null;

    wrapper.appendChild(this.renderChromeBar(viewModel));

    var page = document.createElement("div");
    page.className = "mmm-mirror-os__page mmm-mirror-os__page--" + this.safeClassPart(viewModel.pageId);
    page.appendChild(this.renderShellHeader(viewModel));
    page.appendChild(this.renderPageBody(viewModel));
    wrapper.appendChild(page);

    this.restartChromeClock();
    return wrapper;
  },

  renderChromeBar: function (viewModel) {
    var chrome = document.createElement("div");
    chrome.className = "mmm-mirror-os__chrome";

    var wordmark = document.createElement("div");
    wordmark.className = "mmm-mirror-os__chrome-id";
    wordmark.appendChild(document.createTextNode("MIRROR OS"));
    var surfaceLabel = this.config.header || ((this.config.mirrorOs || {}).home || {}).label || this.config.title;
    if (surfaceLabel) {
      wordmark.appendChild(document.createTextNode(" / "));
      var strong = document.createElement("span");
      strong.className = "mmm-mirror-os__chrome-accent";
      strong.textContent = String(surfaceLabel).toUpperCase();
      wordmark.appendChild(strong);
    }
    chrome.appendChild(wordmark);

    var tabs = document.createElement("div");
    tabs.className = "mmm-mirror-os__page-tabs";
    this.shell.rotationOrder().forEach(function (pageId) {
      var tab = document.createElement("span");
      tab.className = "mmm-mirror-os__page-tab" + (pageId === viewModel.pageId ? " mmm-mirror-os__page-tab--active" : "");
      tab.textContent = this.pageLabel(pageId).toUpperCase();
      tabs.appendChild(tab);
    }, this);
    if (this.shell.state().rotationPaused) {
      var paused = document.createElement("span");
      paused.className = "mmm-mirror-os__page-paused";
      paused.textContent = "⏸";
      tabs.appendChild(paused);
    }
    chrome.appendChild(tabs);

    var clock = document.createElement("div");
    clock.className = "mmm-mirror-os__chrome-clock";
    var timeRow = document.createElement("div");
    timeRow.className = "mmm-mirror-os__chrome-time-row";
    var time = document.createElement("span");
    time.className = "mmm-mirror-os__chrome-time";
    var meridiem = document.createElement("span");
    meridiem.className = "mmm-mirror-os__chrome-meridiem";
    timeRow.appendChild(time);
    timeRow.appendChild(meridiem);
    var date = document.createElement("div");
    date.className = "mmm-mirror-os__chrome-date";
    clock.appendChild(timeRow);
    clock.appendChild(date);
    chrome.appendChild(clock);

    this.chromeClockTime = time;
    this.chromeClockMeridiem = meridiem;
    this.chromeClockDate = date;
    this.updateChromeClockText();

    return chrome;
  },

  clearChromeClockTimer: function () {
    clearInterval(this.chromeClockTimer);
    this.chromeClockTimer = null;
  },

  restartChromeClock: function () {
    this.clearChromeClockTimer();
    this.updateChromeClockText();
    this.chromeClockTimer = setInterval(function () {
      this.updateChromeClockText();
    }.bind(this), 15000);
  },

  updateChromeClockText: function () {
    var now = new Date();
    var time = this.formatClockTime(now);
    if (this.chromeClockTime) this.chromeClockTime.textContent = time.text;
    if (this.chromeClockDate) this.chromeClockDate.textContent = this.formatChromeDate(now);
    if (this.homeClockTime) this.homeClockTime.textContent = time.text;
    if (this.homeClockMeridiem) this.homeClockMeridiem.textContent = time.meridiem;
    if (this.chromeClockMeridiem) this.chromeClockMeridiem.textContent = time.meridiem;
  },

  formatClockTime: function (date) {
    var hours = date.getHours();
    var meridiem = hours >= 12 ? "PM" : "AM";
    var hour12 = hours % 12 || 12;
    return {
      text: String(hour12) + ":" + String(date.getMinutes()).padStart(2, "0"),
      meridiem: meridiem
    };
  },

  formatChromeDate: function (date) {
    var weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    var months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    return weekdays[date.getDay()] + " · " + months[date.getMonth()] + " " + date.getDate();
  },

  renderShellHeader: function (viewModel) {
    var header = document.createElement("div");
    header.className = "mmm-mirror-os__header ph";

    var main = document.createElement("div");
    main.className = "mmm-mirror-os__header-main";

    var eyebrow = document.createElement("div");
    eyebrow.className = "mmm-mirror-os__eyebrow ph-eyebrow";
    eyebrow.textContent = this.pageEyebrow(viewModel);
    main.appendChild(eyebrow);

    var title = document.createElement("div");
    title.className = "mmm-mirror-os__title ph-title mmm-agent-surface__title";
    title.textContent = this.pageTitle(viewModel);
    main.appendChild(title);

    var sub = document.createElement("div");
    sub.className = "mmm-mirror-os__provenance ph-sub mmm-mirror-os__provenance--" + this.safeClassPart(viewModel.state);
    sub.textContent = this.formatProvenanceLine(viewModel);
    main.appendChild(sub);
    header.appendChild(main);

    var metaLines = this.pageMetaLines(viewModel);
    if (metaLines.length) {
      var meta = document.createElement("div");
      meta.className = "mmm-mirror-os__header-meta ph-meta";
      metaLines.forEach(function (line) {
        var item = document.createElement("div");
        item.textContent = line;
        meta.appendChild(item);
      });
      header.appendChild(meta);
    }

    return header;
  },

  renderPageBody: function (viewModel) {
    var body = document.createElement("div");
    body.className = "mmm-mirror-os__body mmm-mirror-os__body--" + this.safeClassPart(viewModel.pageId);

    if (viewModel.state === "summary") {
      body.appendChild(this.renderHomeSummary(viewModel));
      return body;
    }

    if (viewModel.state === "unconfigured") {
      body.appendChild(this.renderUnconfigured(viewModel));
      return body;
    }

    if (viewModel.state === "error") {
      body.appendChild(this.renderStatusPanel(viewModel, viewModel.message || "Source error."));
      return body;
    }

    if (viewModel.state === "stale") {
      body.appendChild(this.renderStatusPanel(viewModel, this.staleStatusMessage(viewModel)));
      return body;
    }

    if (viewModel.pageId === "agents") {
      body.appendChild(this.renderAgentThreads());
      return body;
    }

    if (viewModel.state === "ready") {
      if (viewModel.pageId === "calendar") {
        body.appendChild(this.renderCalendarPage(viewModel));
        return body;
      }

      if (viewModel.pageId === "weather") {
        body.appendChild(this.renderWeatherPage(viewModel));
        return body;
      }

      if (viewModel.pageId === "sports") {
        body.appendChild(this.renderSportsPage(viewModel));
        return body;
      }

      if (viewModel.pageId === "path") {
        body.appendChild(this.renderPathPage(viewModel));
        return body;
      }

      body.appendChild(this.renderEmptyRow("No renderer for this page yet"));
      return body;
    }

    body.appendChild(this.renderStatusPanel(viewModel, "Unknown page state."));
    return body;
  },

  renderCalendarPage: function (viewModel) {
    var container = document.createElement("div");
    container.className = "mmm-mirror-os__calendar cal-layout";

    var result = this.sourceData[viewModel.dataSourceId] || {};
    var data = result.data || {};
    var events = Array.isArray(data.events) ? data.events : [];
    var displayDate = new Date();

    var main = document.createElement("div");
    main.className = "cal-main";

    var dateNum = document.createElement("div");
    dateNum.className = "cal-date-num";
    dateNum.textContent = String(displayDate.getDate());
    main.appendChild(dateNum);

    var dateLabel = document.createElement("div");
    dateLabel.className = "cal-date-label";
    dateLabel.textContent = this.formatCalendarDateLabel(displayDate);
    main.appendChild(dateLabel);

    if (events.length === 0) {
      main.appendChild(this.renderEmptyRow("No upcoming events in the configured feed."));
    } else {
      events.slice(0, 7).forEach(function (event) {
        var row = document.createElement("div");
        row.className = "cal-event" + (this.isEventCurrent(event) ? " now" : "");

        var when = document.createElement("div");
        when.className = "cal-time";
        var dayLabel = this.formatEventDayShort(event, data.timezone);
        if (dayLabel) {
          var dayNode = document.createElement("div");
          dayNode.className = "cal-time-day";
          dayNode.textContent = dayLabel;
          when.appendChild(dayNode);
        }
        var clockNode = document.createElement("div");
        clockNode.className = "cal-time-clock";
        clockNode.textContent = this.formatEventTimeShort(event, data.timezone);
        when.appendChild(clockNode);
        row.appendChild(when);

        var details = document.createElement("div");
        var title = document.createElement("div");
        title.className = "cal-title";
        title.textContent = event.title || "Untitled event";
        details.appendChild(title);

        var where = this.eventLocationLabel(event, result.source);
        if (where) {
          var whereNode = document.createElement("div");
          whereNode.className = "cal-where";
          whereNode.textContent = where;
          details.appendChild(whereNode);
        }

        row.appendChild(details);
        main.appendChild(row);
      }, this);
    }
    container.appendChild(main);

    var sidebar = document.createElement("div");
    sidebar.className = "cal-sidebar";
    var next = events[0];
    var nextLabel = document.createElement("div");
    nextLabel.className = "cal-next-lbl";
    nextLabel.textContent = "// NEXT EVENT";
    sidebar.appendChild(nextLabel);

    var nextTitle = document.createElement("div");
    nextTitle.className = "cal-next-title";
    nextTitle.textContent = next ? (next.title || "Untitled event") : "No upcoming events";
    sidebar.appendChild(nextTitle);

    var nextTime = document.createElement("div");
    nextTime.className = "cal-next-time";
    nextTime.textContent = next ? this.formatEventTime(next, data.timezone) : "—";
    sidebar.appendChild(nextTime);
    sidebar.appendChild(this.renderMonthGrid(events, data.timezone));
    container.appendChild(sidebar);

    return container;
  },

  renderMonthGrid: function (events, timezone) {
    var wrap = document.createElement("div");
    wrap.className = "mini-cal";

    var label = document.createElement("div");
    label.className = "mini-cal-head";
    label.textContent = "// MONTH";
    wrap.appendChild(label);

    var grid = document.createElement("div");
    grid.className = "mini-cal-grid";

    var eventDays = {};
    events.forEach(function (event) {
      var key = this.eventDayKey(event.startsAt, timezone);
      if (key) eventDays[key] = true;
    }, this);

    var now = new Date();
    var year = now.getFullYear();
    var month = now.getMonth();
    var firstDay = new Date(year, month, 1);
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var todayKey = this.dayKey(now);

    ["S", "M", "T", "W", "T", "F", "S"].forEach(function (weekday) {
      var head = document.createElement("span");
      head.className = "mcd";
      head.textContent = weekday;
      grid.appendChild(head);
    });

    for (var pad = 0; pad < firstDay.getDay(); pad += 1) {
      var empty = document.createElement("span");
      empty.className = "mcn other";
      empty.textContent = "";
      grid.appendChild(empty);
    }

    for (var day = 1; day <= daysInMonth; day += 1) {
      var date = new Date(year, month, day);
      var key = this.dayKey(date);
      var cell = document.createElement("span");
      cell.className = "mcn" +
        (key === todayKey ? " today" : "") +
        (eventDays[key] ? " has-ev" : "");
      cell.textContent = String(day);
      grid.appendChild(cell);
    }

    wrap.appendChild(grid);
    return wrap;
  },

  dayKey: function (date) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  },

  eventDayKey: function (isoString, timezone) {
    var parsed = Date.parse(isoString);
    if (!Number.isFinite(parsed)) return null;
    var date = new Date(parsed);
    if (timezone) {
      try {
        var parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
        return parts;
      } catch (error) {
        // fall through to local time below
      }
    }
    return this.dayKey(date);
  },

  formatEventTime: function (event, timezone) {
    var parsed = Date.parse(event.startsAt);
    if (!Number.isFinite(parsed)) return "";
    var date = new Date(parsed);
    var options = { weekday: "short", month: "short", day: "numeric" };
    if (!event.allDay) {
      options.hour = "numeric";
      options.minute = "2-digit";
    }
    if (timezone) options.timeZone = timezone;
    try {
      return new Intl.DateTimeFormat(undefined, options).format(date);
    } catch (error) {
      delete options.timeZone;
      return new Intl.DateTimeFormat(undefined, options).format(date);
    }
  },

  renderWeatherPage: function (viewModel) {
    var container = document.createElement("div");
    container.className = "mmm-mirror-os__weather wx-layout";

    var result = this.sourceData[viewModel.dataSourceId] || {};
    var data = result.data || {};
    var current = data.current;
    var daily = Array.isArray(data.daily) ? data.daily : [];

    if (!current || typeof current !== "object") {
      container.appendChild(this.renderEmptyRow("Weather data is unavailable."));
      return container;
    }

    var currentPanel = document.createElement("div");
    currentPanel.className = "wx-top";

    var left = document.createElement("div");
    var temp = document.createElement("div");
    temp.className = "wx-temp";
    var tempNumber = document.createElement("span");
    tempNumber.textContent = this.formatWeatherNumber(current.temperatureF);
    temp.appendChild(tempNumber);
    var tempUnit = document.createElement("sup");
    tempUnit.textContent = "°F";
    temp.appendChild(tempUnit);
    left.appendChild(temp);

    var condition = document.createElement("div");
    condition.className = "wx-cond";
    condition.textContent = this.formatWeatherCondition(current.condition);
    left.appendChild(condition);

    var metaParts = [];
    if (current.apparentF !== null && current.apparentF !== undefined) metaParts.push("FEELS " + this.formatWeatherNumber(current.apparentF) + "°");
    if (current.windMph !== null && current.windMph !== undefined) metaParts.push("WIND " + this.formatWeatherNumber(current.windMph) + " MPH");
    if (current.humidityPct !== null && current.humidityPct !== undefined) metaParts.push("HUMIDITY " + this.formatWeatherNumber(current.humidityPct) + "%");
    if (metaParts.length) {
      var details = document.createElement("div");
      details.className = "wx-details";
      details.textContent = metaParts.join(" / ");
      left.appendChild(details);
    }
    currentPanel.appendChild(left);

    var glyph = document.createElement("div");
    glyph.className = "wx-glyph";
    glyph.textContent = current.condition && current.condition.glyph ? current.condition.glyph : "?";
    currentPanel.appendChild(glyph);
    container.appendChild(currentPanel);

    if (daily.length === 0) return container;

    var forecast = document.createElement("div");
    forecast.className = "wx-forecast";
    daily.slice(0, 5).forEach(function (day) {
      var cell = document.createElement("div");
      cell.className = "wx-day";

      var weekday = document.createElement("div");
      weekday.className = "wx-day-name";
      weekday.textContent = this.formatWeatherWeekday(day.date);
      cell.appendChild(weekday);

      var high = document.createElement("div");
      high.className = "wx-day-hi";
      high.textContent = this.formatWeatherNumber(day.highF) + "°";
      cell.appendChild(high);

      var low = document.createElement("div");
      low.className = "wx-day-lo";
      low.textContent = this.formatWeatherNumber(day.lowF) + "°";
      cell.appendChild(low);

      var dayCondition = document.createElement("div");
      dayCondition.className = "wx-day-cond";
      dayCondition.textContent = this.formatWeatherCondition(day.condition);
      cell.appendChild(dayCondition);

      forecast.appendChild(cell);
    }, this);

    container.appendChild(forecast);
    return container;
  },

  formatWeatherCondition: function (condition) {
    if (!condition || typeof condition !== "object") return "? Unknown";
    return [condition.glyph, condition.label || "Unknown"].filter(Boolean).join(" ");
  },

  formatWeatherNumber: function (value) {
    var number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return String(Math.round(number));
  },

  formatWeatherWeekday: function (dateString) {
    var parsed = Date.parse(dateString + "T00:00:00");
    if (!Number.isFinite(parsed)) return dateString || "";
    try {
      return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(parsed));
    } catch (error) {
      return dateString;
    }
  },

  renderSportsPage: function (viewModel) {
    var container = document.createElement("div");
    container.className = "mmm-mirror-os__sports sports-layout";

    var result = this.sourceData[viewModel.dataSourceId] || {};
    var data = result.data || {};
    var warnings = Array.isArray(data.warnings) ? data.warnings : [];
    var games = Array.isArray(data.games) ? data.games : [];

    if (warnings.length > 0) {
      var warning = document.createElement("div");
      warning.className = "mmm-mirror-os__sports-warning mgrid-bar";
      warning.textContent = "Unavailable: " + warnings.join(", ").toUpperCase();
      container.appendChild(warning);
    }

    var head = document.createElement("div");
    head.className = "sports-head-row";
    ["MATCH", "SCORE", "STATE", "TIME"].forEach(function (label) {
      var cell = document.createElement("div");
      cell.className = "sc-hd";
      cell.textContent = label;
      head.appendChild(cell);
    });
    container.appendChild(head);

    if (games.length === 0) {
      container.appendChild(this.renderEmptyRow("No configured-team games on the current ESPN scoreboard."));
      return container;
    }

    games.forEach(function (game) {
      container.appendChild(this.renderSportsGameRow(game));
    }, this);

    return container;
  },

  renderSportsGameRow: function (game) {
    var away = game.awayTeam || {};
    var home = game.homeTeam || {};
    var statusPart = this.safeClassPart(game.status);
    var row = document.createElement("div");
    row.className = "mmm-mirror-os__sports-row sports-game " + statusPart;

    var awayScore = Number(away.score);
    var homeScore = Number(home.score);
    var hasScores = Number.isFinite(awayScore) && Number.isFinite(homeScore) && statusPart !== "upcoming";
    var awayLeads = hasScores && awayScore > homeScore;
    var homeLeads = hasScores && homeScore > awayScore;

    var match = document.createElement("div");
    match.className = "s-match";
    var league = document.createElement("div");
    league.className = "s-league-tag";
    league.textContent = String(game.league || "").toUpperCase();
    match.appendChild(league);
    this.appendSportsTeam(match, away.abbr || away.name || "--", awayLeads);
    this.appendSportsTeam(match, home.abbr || home.name || "--", homeLeads);
    row.appendChild(match);

    var score = document.createElement("div");
    score.className = "s-score";
    var awayScoreNode = document.createElement("span");
    awayScoreNode.className = awayLeads ? "lead" : (hasScores ? "" : "dim");
    awayScoreNode.textContent = hasScores ? String(away.score || "0") : "—";
    score.appendChild(awayScoreNode);
    var homeScoreNode = document.createElement("span");
    homeScoreNode.className = homeLeads ? "lead" : (hasScores ? "" : "dim");
    homeScoreNode.textContent = hasScores ? String(home.score || "0") : "—";
    score.appendChild(homeScoreNode);
    row.appendChild(score);

    var state = document.createElement("div");
    state.className = "s-game-st";
    if (statusPart === "live") {
      var live = document.createElement("div");
      live.className = "s-live-tag";
      live.textContent = "LIVE";
      state.appendChild(live);
    }
    var detail = document.createElement("span");
    detail.className = "s-small";
    detail.textContent = game.statusDetail || game.status || "";
    state.appendChild(detail);
    row.appendChild(state);

    var time = document.createElement("div");
    time.className = "s-period";
    time.textContent = this.formatSportsTime(game.startsAt);
    row.appendChild(time);

    return row;
  },

  renderPathPage: function (viewModel) {
    var container = document.createElement("div");
    container.className = "mmm-mirror-os__path path-layout";

    var result = this.sourceData[viewModel.dataSourceId] || {};
    var data = result.data || {};
    var departures = Array.isArray(data.departures) ? data.departures : [];

    var service = document.createElement("div");
    service.className = "mgrid-bar path-svc";
    var serviceLabel = document.createElement("span");
    serviceLabel.textContent = "// DEPARTURES";
    service.appendChild(serviceLabel);
    var asOf = document.createElement("span");
    asOf.textContent = "AS OF " + (this.formatRelativeAge(result.updatedAt) || "UNKNOWN");
    service.appendChild(asOf);
    container.appendChild(service);

    if (departures.length === 0) {
      container.appendChild(this.renderEmptyRow("No upcoming PATH departures for the configured station."));
      return container;
    }

    this.groupPathDepartures(departures).forEach(function (group) {
      container.appendChild(this.renderPathRouteRow(group));
    }, this);

    return container;
  },

  renderPathRouteRow: function (group) {
    var row = document.createElement("div");
    row.className = "path-route" + (group.soon ? " path-route--soon" : "");

    var nameCell = document.createElement("div");
    nameCell.className = "path-route-name-cell";
    var route = document.createElement("div");
    route.className = "path-rname";
    route.textContent = group.routeLabel;
    nameCell.appendChild(route);
    var direction = document.createElement("div");
    direction.className = "path-rdir";
    direction.textContent = group.destination;
    nameCell.appendChild(direction);
    row.appendChild(nameCell);

    var trains = document.createElement("div");
    trains.className = "path-trains-cell";
    group.departures.forEach(function (departure, index) {
      if (index > 0) {
        var sep = document.createElement("span");
        sep.className = "path-sep";
        sep.textContent = "/";
        trains.appendChild(sep);
      }
      var train = document.createElement("span");
      train.className = "path-train";
      train.textContent = String(departure.minutes);
      var unit = document.createElement("span");
      unit.textContent = "MIN";
      train.appendChild(unit);
      trains.appendChild(train);
    });
    row.appendChild(trains);

    var status = document.createElement("div");
    status.className = "path-status-cell";
    var statusText = document.createElement("span");
    statusText.className = "path-status " + (group.soon ? "path-status--soon" : "path-status--ok");
    statusText.textContent = group.soon ? "△ DUE" : "· LIVE";
    status.appendChild(statusText);
    row.appendChild(status);

    return row;
  },
  renderHomeSummary: function (viewModel) {
    if (!window.MMMAgentSurfaceHomeView || typeof window.MMMAgentSurfaceHomeView.deriveHomeView !== "function") {
      return this.renderMessage("error", "Home view unavailable.");
    }

    var rotationOrder = this.shell.rotationOrder();
    var sourceStates = [];
    rotationOrder.forEach(function (pageId) {
      if (pageId === "home") return;
      var sourceView = this.shell.pageViewModel(pageId, { payloadStates: this.payloadStates, now: Date.now() });
      if (sourceView) sourceStates.push(sourceView);
    }, this);

    var homeView = window.MMMAgentSurfaceHomeView.deriveHomeView({
      now: new Date(),
      homeConfig: this.config.mirrorOs && this.config.mirrorOs.home,
      rotationOrder: rotationOrder,
      currentPageId: viewModel.pageId,
      dwellSeconds: this.shell.dwellSeconds(viewModel.pageId),
      sourceStates: sourceStates
    });

    homeView.currentPageId = viewModel.pageId;
    homeView.rotationRows = rotationOrder.map(function (pageId) {
      return {
        id: pageId,
        label: this.pageLabel(pageId),
        dwellSeconds: this.shell.dwellSeconds(pageId)
      };
    }, this);

    return this.renderHomePage(homeView);
  },

  renderHomePage: function (homeView) {
    var panel = document.createElement("div");
    panel.className = "mmm-mirror-os__home home-layout";

    var clockCell = document.createElement("div");
    clockCell.className = "home-clock-cell";

    var time = document.createElement("div");
    time.className = "home-time";
    var timeDigits = document.createElement("span");
    timeDigits.className = "home-time-digits";
    var timeMeridiem = document.createElement("span");
    timeMeridiem.className = "home-time-meridiem";
    time.appendChild(timeDigits);
    time.appendChild(timeMeridiem);
    clockCell.appendChild(time);
    this.homeClockTime = timeDigits;
    this.homeClockMeridiem = timeMeridiem;

    var dateLine = document.createElement("div");
    dateLine.className = "home-dateline";
    dateLine.textContent = homeView.dateLine;
    clockCell.appendChild(dateLine);

    var next = document.createElement("div");
    next.className = "home-next";
    next.textContent = "NEXT: " + homeView.nextPage.label + " · " + homeView.nextPage.dwellSeconds + "S DWELL";
    clockCell.appendChild(next);
    panel.appendChild(clockCell);

    var sidebar = document.createElement("div");
    sidebar.className = "home-sidebar";

    var rotation = document.createElement("div");
    rotation.className = "home-panel";
    var rotationTitle = document.createElement("div");
    rotationTitle.className = "hp-title";
    rotationTitle.textContent = "// PAGE ROTATION";
    rotation.appendChild(rotationTitle);
    (homeView.rotationRows || []).forEach(function (page) {
      var row = document.createElement("div");
      row.className = "rot-row" + (page.id === homeView.currentPageId ? " now" : "");
      var label = document.createElement("span");
      label.textContent = page.label;
      row.appendChild(label);
      var state = document.createElement("span");
      state.className = page.id === homeView.currentPageId ? "rot-now-tag" : "rot-wait";
      state.textContent = page.id === homeView.currentPageId ? "→ NOW" : page.dwellSeconds + "S";
      row.appendChild(state);
      rotation.appendChild(row);
    });
    sidebar.appendChild(rotation);

    var sources = document.createElement("div");
    sources.className = "home-panel";
    var sourcesTitle = document.createElement("div");
    sourcesTitle.className = "hp-title";
    sourcesTitle.textContent = "// SOURCES";
    sources.appendChild(sourcesTitle);
    homeView.readiness.rows.forEach(function (source) {
      var row = document.createElement("div");
      row.className = "mmm-mirror-os__source-row mmm-mirror-os__home-source-row mmm-mirror-os__source-row--" + this.safeClassPart(source.state);

      var sourceLabel = document.createElement("span");
      sourceLabel.className = "mmm-mirror-os__source-label";
      sourceLabel.textContent = source.label;
      row.appendChild(sourceLabel);

      var state = document.createElement("span");
      state.className = "mmm-mirror-os__source-state";
      state.textContent = source.glyph + " " + source.state;
      row.appendChild(state);

      sources.appendChild(row);
    }, this);
    sidebar.appendChild(sources);

    var control = document.createElement("div");
    control.className = "home-panel";
    var controlTitle = document.createElement("div");
    controlTitle.className = "hp-title";
    controlTitle.textContent = "// CONTROL";
    control.appendChild(controlTitle);
    var phone = document.createElement("div");
    phone.className = "ctrl-hint";
    phone.textContent = "phone  page controls";
    control.appendChild(phone);
    var voice = document.createElement("div");
    voice.className = "ctrl-hint";
    voice.textContent = "voice  siri shortcuts";
    control.appendChild(voice);
    var lastCmd = document.createElement("div");
    lastCmd.className = "ctrl-hint";
    lastCmd.textContent = "last cmd  " + (this.shell ? this.shell.state().lastCommandSource : "system");
    control.appendChild(lastCmd);
    sidebar.appendChild(control);

    panel.appendChild(sidebar);
    this.updateChromeClockText();
    return panel;
  },

  renderUnconfigured: function (viewModel) {
    return this.renderStatusPanel(viewModel, viewModel.message || viewModel.unconfiguredCopy || "Not configured.");
  },

  renderEmptyRow: function (message) {
    var row = document.createElement("div");
    row.className = "mmm-mirror-os__empty-row";
    row.textContent = message;
    return row;
  },

  renderAgentThreads: function () {
    if (!this.snapshot) return this.renderUnconfigured(this.shell.pageViewModel("agents", { payloadStates: {}, now: Date.now() }));

    var agentsView = window.MMMAgentSurfaceAgentsView;
    if (!agentsView || typeof agentsView.deriveAgentsView !== "function") {
      return this.renderMessage("error", "Agents view helper unavailable.");
    }

    var view = agentsView.deriveAgentsView(this.snapshot, { maxThreads: this.config.maxThreads });
    var groups = view && Array.isArray(view.groups) ? view.groups : [];
    if (groups.length === 0) return this.renderMessage("waiting", "No active agent threads in the latest snapshot.");

    var list = document.createElement("div");
    list.className = "mmm-mirror-os__cards mmm-agent-surface__cards ag-grid";

    groups.forEach(function (group) {
      var threads = group && Array.isArray(group.threads) ? group.threads : [];
      if (threads.length === 0) return;

      if (group.project) {
        var heading = document.createElement("div");
        heading.className = "mmm-agent-surface__project-heading ag-divider";
        heading.textContent = group.project;
        list.appendChild(heading);
      }

      threads.forEach(function (thread) {
        list.appendChild(this.renderThreadCard(thread, { project: group.project }));
      }, this);
    }, this);

    return list;
  },

  isSnapshotStale: function () {
    if (!this.snapshot || !this.snapshot.generatedAt) return false;
    var generatedAt = Date.parse(this.snapshot.generatedAt);
    if (!Number.isFinite(generatedAt)) return false;
    return Date.now() - generatedAt > this.config.staleAfterMs;
  },

  renderMessage: function (kind, message) {
    var viewModel = { state: kind || "unknown", glyph: kind === "error" ? "!" : kind === "stale" ? "△" : kind === "waiting" ? "…" : "·", missingConfigKeys: [] };
    return this.renderStatusPanel(viewModel, message);
  },

  renderSummary: function () {
    var summary = this.summary || this.snapshot.summary || {};
    var source = this.snapshot.source || {};
    var grid = document.createElement("div");
    grid.className = "mmm-agent-surface__summary";

    this.appendMetric(grid, "Active", summary.activeCount);
    this.appendMetric(grid, "Blocked", summary.blockedCount);
    this.appendMetric(grid, "Done", summary.completedCount);
    this.appendMetric(grid, "Threads", Array.isArray(this.snapshot.threads) ? this.snapshot.threads.length : 0);

    var meta = document.createElement("div");
    meta.className = "mmm-agent-surface__meta";
    meta.textContent = [source.label, this.formatTime(this.snapshot.generatedAt)].filter(Boolean).join(" • ");
    grid.appendChild(meta);

    return grid;
  },

  appendMetric: function (parent, label, value) {
    var metric = document.createElement("div");
    metric.className = "mmm-agent-surface__metric";

    var number = document.createElement("div");
    number.className = "mmm-agent-surface__metric-value";
    number.textContent = value === undefined || value === null ? "0" : String(value);
    metric.appendChild(number);

    var caption = document.createElement("div");
    caption.className = "mmm-agent-surface__metric-label";
    caption.textContent = label;
    metric.appendChild(caption);

    parent.appendChild(metric);
  },

  renderThreadCard: function (thread, options) {
    thread = thread || {};
    options = options || {};

    var status = this.safeClassPart(thread.status);
    var card = document.createElement("article");
    card.className = "mmm-agent-surface__card mmm-agent-surface__card--" + status + " ag-item ag-item--" + status;

    var title = document.createElement("div");
    title.className = "mmm-agent-surface__card-title ag-project";
    title.textContent = thread.title || options.project || "";
    card.appendChild(title);

    if (thread.identifiers) {
      var identifiers = document.createElement("div");
      identifiers.className = "mmm-agent-surface__identifiers ag-ref";
      identifiers.textContent = thread.identifiers;
      card.appendChild(identifiers);
    }

    if (thread.brief) {
      var brief = document.createElement("div");
      brief.className = "mmm-agent-surface__last-message ag-brief";
      brief.textContent = thread.brief;
      card.appendChild(brief);
    }

    var foot = document.createElement("div");
    foot.className = "mmm-agent-surface__thread-meta ag-foot";

    var age = this.formatRelativeAge(thread.updatedAt);
    var updated = document.createElement("span");
    updated.className = "mmm-agent-surface__updated-age ag-updated";
    updated.textContent = age || "updated unknown";
    foot.appendChild(updated);

    var state = document.createElement("span");
    state.className = "mmm-agent-surface__state mmm-agent-surface__thread-status ag-status";
    state.textContent = this.statusGlyph(thread.status) + " " + String(thread.status || "unknown").toUpperCase();
    foot.appendChild(state);

    card.appendChild(foot);
    return card;
  },

  renderStatusPanel: function (viewModel, message) {
    viewModel = viewModel || {};
    var panel = document.createElement("div");
    panel.className = "mmm-mirror-os__status-panel mmm-mirror-os__status-panel--" + this.safeClassPart(viewModel.state);

    var bar = document.createElement("div");
    bar.className = "mgrid-bar";
    bar.textContent = "// STATUS";
    panel.appendChild(bar);

    var cell = document.createElement("div");
    cell.className = "mmm-mirror-os__status-cell";
    var copy = document.createElement("div");
    copy.className = "mmm-mirror-os__status-copy mmm-mirror-os__status-copy--" + this.safeClassPart(viewModel.state);
    copy.textContent = (viewModel.glyph ? viewModel.glyph + " " : "") + (message || "Status unavailable.");
    cell.appendChild(copy);

    if (viewModel.missingConfigKeys && viewModel.missingConfigKeys.length) {
      var setup = document.createElement("div");
      setup.className = "mmm-mirror-os__setup";
      setup.textContent = "SETUP: " + viewModel.missingConfigKeys.join(", ");
      cell.appendChild(setup);
    }

    panel.appendChild(cell);
    return panel;
  },

  pageLabel: function (pageId) {
    var labels = { home: "Home", agents: "Agents", calendar: "Calendar", weather: "Weather", path: "PATH", sports: "Sports" };
    return labels[pageId] || pageId || "";
  },

  pageEyebrow: function (viewModel) {
    var contexts = {
      home: "HOME / AMBIENT",
      agents: "AGENT SURFACE / COMMAND CENTER",
      calendar: "CALENDAR / DAY VIEW",
      weather: "WEATHER / CURRENT CONDITIONS",
      path: "PATH / DEPARTURE BOARD",
      sports: "SPORTS / SCOREBOARD"
    };
    return contexts[viewModel.pageId] || String(viewModel.label || viewModel.pageId || "").toUpperCase();
  },

  pageTitle: function (viewModel) {
    if (viewModel.pageId === "home") return "Overview";
    if (viewModel.pageId === "agents") return "Active Work";
    if (viewModel.pageId === "calendar") return "Today";
    if (viewModel.pageId === "weather") {
      var weatherResult = this.sourceData[viewModel.dataSourceId] || {};
      var weatherData = weatherResult.data || {};
      return weatherData.locationLabel || "Weather";
    }
    if (viewModel.pageId === "path") return "Next Trains";
    if (viewModel.pageId === "sports") return "Scores";
    return viewModel.label || "";
  },

  formatProvenanceLine: function (viewModel) {
    var state = String(viewModel.state || "unknown").toUpperCase();
    var parts = [viewModel.glyph ? viewModel.glyph + " " + state : state];
    if (viewModel.provenance) parts.push(viewModel.provenance);
    else if (viewModel.message) parts.push(viewModel.message);
    return parts.join(" · ");
  },

  pageMetaLines: function (viewModel) {
    var now = new Date();
    if (viewModel.pageId === "home") return [];
    if (viewModel.pageId === "agents") {
      var source = this.snapshot && this.snapshot.source ? this.snapshot.source : {};
      return [source.label || "Agent Snapshot", this.snapshot && this.snapshot.generatedAt ? this.formatDateTimeStamp(this.snapshot.generatedAt) : this.formatDateTimeStamp(now)];
    }
    if (viewModel.pageId === "calendar") {
      return [this.formatMonthWeek(now), this.formatWeekday(now)];
    }
    if (viewModel.pageId === "weather") {
      var weatherResult = this.sourceData[viewModel.dataSourceId] || {};
      var weatherData = weatherResult.data || {};
      var current = weatherData.current || {};
      var feels = current.apparentF !== null && current.apparentF !== undefined ? "FEELS " + this.formatWeatherNumber(current.apparentF) + "°" : this.formatWeekday(now);
      return [feels, this.formatShortMonthDate(now) + " · " + this.formatClockTimeLabel(now)];
    }
    if (viewModel.pageId === "path") {
      var pathResult = this.sourceData[viewModel.dataSourceId] || {};
      return [this.formatClockTimeLabel(now), "AS OF " + (this.formatRelativeAge(pathResult.updatedAt) || "UNKNOWN")];
    }
    if (viewModel.pageId === "sports") {
      return [this.formatWeekday(now), this.formatShortMonthDate(now) + " · " + this.formatClockTimeLabel(now)];
    }
    return [];
  },

  staleStatusMessage: function (viewModel) {
    if (viewModel.pageId === "agents" && this.isSnapshotStale()) return "Snapshot is stale. Waiting for an updated upload.";
    return viewModel.message || "Data is stale.";
  },

  formatDateTimeStamp: function (value) {
    var date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0") + " · " + this.formatClockTimeLabel(date);
  },

  formatClockTimeLabel: function (date) {
    var time = this.formatClockTime(date);
    return time.text + " " + time.meridiem;
  },

  formatWeekday: function (date) {
    try {
      return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
    } catch (error) {
      return "";
    }
  },

  formatShortMonthDate: function (date) {
    try {
      return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
    } catch (error) {
      return "";
    }
  },

  formatMonthWeek: function (date) {
    try {
      var month = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
      return month.toUpperCase() + " · WEEK " + this.weekNumber(date);
    } catch (error) {
      return "WEEK " + this.weekNumber(date);
    }
  },

  weekNumber: function (date) {
    var start = new Date(date.getFullYear(), 0, 1);
    var diff = Math.floor((date - start) / 86400000);
    return Math.ceil((diff + start.getDay() + 1) / 7);
  },

  formatCalendarDateLabel: function (date) {
    var weekdays = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
    var months = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
    return weekdays[date.getDay()] + " · " + months[date.getMonth()] + " " + date.getFullYear();
  },

  formatEventTimeShort: function (event, timezone) {
    if (event.allDay) return "ALL DAY";
    var parsed = Date.parse(event.startsAt);
    if (!Number.isFinite(parsed)) return "";
    var options = { hour: "numeric", minute: "2-digit" };
    if (timezone) options.timeZone = timezone;
    try {
      return new Intl.DateTimeFormat(undefined, options).format(new Date(parsed));
    } catch (error) {
      delete options.timeZone;
      return new Intl.DateTimeFormat(undefined, options).format(new Date(parsed));
    }
  },

  formatEventDayShort: function (event, timezone) {
    var parsed = Date.parse(event.startsAt);
    if (!Number.isFinite(parsed)) return "";
    var options = { weekday: "short", month: "short", day: "numeric" };
    if (timezone) options.timeZone = timezone;
    var formatter;
    try {
      formatter = new Intl.DateTimeFormat(undefined, options);
    } catch (error) {
      delete options.timeZone;
      formatter = new Intl.DateTimeFormat(undefined, options);
    }
    var eventDay = formatter.format(new Date(parsed));
    if (eventDay === formatter.format(new Date())) return "";
    return eventDay.toUpperCase();
  },

  eventLocationLabel: function (event, source) {
    return event.location || source || "";
  },

  isEventCurrent: function (event) {
    var start = Date.parse(event.startsAt);
    var end = Date.parse(event.endsAt);
    var now = Date.now();
    return Number.isFinite(start) && Number.isFinite(end) && start <= now && now <= end;
  },

  groupPathDepartures: function (departures) {
    var groups = [];
    var byKey = {};
    departures.forEach(function (departure) {
      var routeLabel = departure.routeLabel || departure.routeId || "PATH";
      var destination = departure.destination || departure.headsign || "Next departure";
      var key = routeLabel + "\u0000" + destination;
      if (!byKey[key]) {
        byKey[key] = { routeLabel: routeLabel, destination: destination, departures: [], soon: false };
        groups.push(byKey[key]);
      }
      byKey[key].departures.push(departure);
      if (Number(departure.minutes) <= 2) byKey[key].soon = true;
    });
    return groups;
  },

  appendSportsTeam: function (parent, name, lead) {
    var team = document.createElement("div");
    team.className = "s-team" + (lead ? " lead" : "");
    team.textContent = name;
    parent.appendChild(team);
  },

  formatSportsTime: function (value) {
    if (!value) return "—";
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    try {
      return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
    } catch (error) {
      return this.formatTime(value);
    }
  },

  statusGlyph: function (status) {
    var glyphs = {
      running: "▶",
      blocked: "×",
      done: "✓",
      failed: "!",
      idle: "·",
      waiting: "…",
      stale: "△",
      unconfigured: "□",
      unknown: "?"
    };
    return glyphs[this.safeClassPart(status)] || glyphs.unknown;
  },

  formatTime: function (value) {
    if (!value) return "";
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  },

  formatRelativeAge: function (value) {
    if (!value) return "";
    var date = Date.parse(value);
    if (!Number.isFinite(date)) return "";
    var ageSeconds = Math.max(0, Math.floor((Date.now() - date) / 1000));
    if (ageSeconds < 10) return "just now";
    if (ageSeconds < 60) return ageSeconds + "s ago";
    var minutes = Math.floor(ageSeconds / 60);
    if (minutes < 60) return minutes + "m ago";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h ago";
    return Math.floor(hours / 24) + "d ago";
  },

  safeClassPart: function (value) {
    return String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  }
});
