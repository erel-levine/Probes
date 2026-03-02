import { useState, useEffect } from 'react'
import './App.css'

type ProbeKey = 'probe1' | 'probe2' | 'probe3' | 'probe4';
type TemperatureUnit = 'c' | 'f';

interface ProbesData {
  probe1: number | null;
  probe2: number | null;
  probe3: number | null;
  probe4: number | null;
  connected: boolean;
  connection_state?: 'connected' | 'reconnecting' | 'searching';
  device_address?: string | null;
}

interface ProbeSample {
  timestamp: number;
  value: number;
}

type ProbeHistory = Record<ProbeKey, ProbeSample[]>;
type ProbeRange = { min: number; max: number };
type ProbeRanges = Partial<Record<ProbeKey, ProbeRange>>;
type ProbeRangeDraft = { min: string; max: string };
type ProbeRangeDrafts = Partial<Record<ProbeKey, ProbeRangeDraft>>;

const PROBE_KEYS: ProbeKey[] = ['probe1', 'probe2', 'probe3', 'probe4'];
const HISTORY_STORAGE_KEY = 'tp25_probe_history_v1';
const UNIT_STORAGE_KEY = 'tp25_temperature_unit_v1';
const TEN_MINUTES_MS = 10 * 60 * 1000;
const WS_WATCHDOG_MS = 4000;
const WS_STALE_MS = 12000;
const PROBE_LIVE_TIMEOUT_MS = 20000;
const CHART_WIDTH = 560;
const CHART_HEIGHT = 180;
const X_TICK_COUNT = 6;
const Y_TICK_COUNT = 4;

interface ChartBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface ChartDomain {
  startTs: number;
  endTs: number;
  minValue: number;
  maxValue: number;
}

const emptyProbeHistory = (): ProbeHistory => ({
  probe1: [],
  probe2: [],
  probe3: [],
  probe4: []
});

const loadHistoryFromStorage = (): ProbeHistory => {
  if (typeof window === 'undefined') {
    return emptyProbeHistory();
  }

  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) {
      return emptyProbeHistory();
    }

    const parsed = JSON.parse(raw) as Partial<ProbeHistory>;
    const base = emptyProbeHistory();

    PROBE_KEYS.forEach((key) => {
      const samples = parsed[key];
      if (!Array.isArray(samples)) {
        return;
      }

      base[key] = samples.filter(
        (sample): sample is ProbeSample => (
          typeof sample?.timestamp === 'number' &&
          Number.isFinite(sample.timestamp) &&
          typeof sample?.value === 'number' &&
          Number.isFinite(sample.value)
        )
      );
    });

    return base;
  } catch {
    return emptyProbeHistory();
  }
};

const loadTemperatureUnitFromStorage = (): TemperatureUnit => {
  if (typeof window === 'undefined') {
    return 'c';
  }

  const stored = window.localStorage.getItem(UNIT_STORAGE_KEY);
  if (stored === 'f') {
    return 'f';
  }
  return 'c';
};

const unitSymbol = (unit: TemperatureUnit): string => (unit === 'f' ? '°F' : '°C');

const convertTemperature = (value: number, unit: TemperatureUnit): number => {
  if (unit === 'f') {
    return value * 9 / 5 + 32;
  }
  return value;
};

const convertRate = (value: number, unit: TemperatureUnit): number => {
  if (unit === 'f') {
    return value * 9 / 5;
  }
  return value;
};

const toCelsius = (value: number, unit: TemperatureUnit): number => {
  if (unit === 'f') {
    return (value - 32) * 5 / 9;
  }
  return value;
};

const formatTemperature = (value: number | null, unit: TemperatureUnit): string => {
  if (value === null) {
    return 'N/A';
  }
  return `${convertTemperature(value, unit).toFixed(1)}${unitSymbol(unit)}`;
};

const formatDuration = (startTimestamp: number): string => {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startTimestamp) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
};

const calculateRatePerMinute = (start: ProbeSample, end: ProbeSample): number | null => {
  const deltaMinutes = (end.timestamp - start.timestamp) / 60000;
  if (deltaMinutes < 0.5) {
    return null;
  }
  return (end.value - start.value) / deltaMinutes;
};

const formatRate = (value: number | null, unit: TemperatureUnit): string => {
  if (value === null) {
    return '—';
  }
  const convertedRate = convertRate(value, unit);
  const sign = value > 0 ? '+' : '';
  return `${sign}${convertedRate.toFixed(1)}${unitSymbol(unit)}/min`;
};

const getStats = (samples: ProbeSample[]) => {
  if (samples.length === 0) {
    return null;
  }

  const values = samples.map((sample) => sample.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((acc, value) => acc + value, 0) / values.length;

  const first = samples[0];
  const last = samples[samples.length - 1];
  const sessionDurationMs = last.timestamp - first.timestamp;
  const useTenMinuteWindow = sessionDurationMs > TEN_MINUTES_MS;

  let rate: number | null = null;
  if (useTenMinuteWindow) {
    const tenMinuteStart = last.timestamp - TEN_MINUTES_MS;
    const windowSamples = samples.filter((sample) => sample.timestamp >= tenMinuteStart);
    if (windowSamples.length >= 2) {
      rate = calculateRatePerMinute(windowSamples[0], windowSamples[windowSamples.length - 1]);
    }
  }

  if (rate === null) {
    rate = calculateRatePerMinute(first, last);
  }

  return {
    min,
    max,
    avg,
    rate,
    rateLabel: useTenMinuteWindow ? 'Rate (10m avg)' : 'Rate (session avg)',
    connectedFor: formatDuration(first.timestamp)
  };
};

const getChartBounds = (width: number, height: number): ChartBounds => ({
  left: 46,
  right: width - 12,
  top: 14,
  bottom: height - 28
});

const getChartDomain = (samples: ProbeSample[]): ChartDomain => {
  const firstTs = samples[0].timestamp;
  const lastTs = samples[samples.length - 1].timestamp;
  const values = samples.map((sample) => sample.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);

  if (rawMin === rawMax) {
    const delta = Math.max(1, Math.abs(rawMin) * 0.05);
    return {
      startTs: firstTs,
      endTs: lastTs === firstTs ? firstTs + 1 : lastTs,
      minValue: rawMin - delta,
      maxValue: rawMax + delta
    };
  }

  const padding = (rawMax - rawMin) * 0.08;
  return {
    startTs: firstTs,
    endTs: lastTs === firstTs ? firstTs + 1 : lastTs,
    minValue: rawMin - padding,
    maxValue: rawMax + padding
  };
};

const buildTicks = (min: number, max: number, count: number): number[] => {
  if (count <= 1) {
    return [min];
  }

  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, index) => min + index * step);
};

const formatElapsedTick = (elapsedMs: number): string => {
  const totalMinutes = Math.max(0, Math.round(elapsedMs / 60000));
  if (totalMinutes < 60) {
    return `${totalMinutes}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${minutes.toString().padStart(2, '0')}`;
};

const formatAxisTemperature = (value: number, unit: TemperatureUnit): string => {
  return `${Math.round(convertTemperature(value, unit))}${unitSymbol(unit)}`;
};

const buildPolylinePoints = (samples: ProbeSample[], bounds: ChartBounds, domain: ChartDomain): string => {
  if (samples.length < 2) {
    return '';
  }

  const maxPoints = 180;
  const step = Math.max(1, Math.ceil(samples.length / maxPoints));
  const reduced = samples.filter((_, index) => index % step === 0 || index === samples.length - 1);

  return reduced
    .map((sample) => {
      const xRatio = (sample.timestamp - domain.startTs) / (domain.endTs - domain.startTs);
      const yRatio = (sample.value - domain.minValue) / (domain.maxValue - domain.minValue);
      const x = bounds.left + xRatio * (bounds.right - bounds.left);
      const y = bounds.bottom - yRatio * (bounds.bottom - bounds.top);
      return `${x},${y}`;
    })
    .join(' ');
};

const getLastProbeSample = (samples: ProbeSample[]): ProbeSample | null => {
  if (samples.length === 0) {
    return null;
  }
  return samples[samples.length - 1];
};

function App() {
  const [data, setData] = useState<ProbesData>({
    probe1: null,
    probe2: null,
    probe3: null,
    probe4: null,
    connected: false
  });
  const [history, setHistory] = useState<ProbeHistory>(() => loadHistoryFromStorage());
  const [temperatureUnit, setTemperatureUnit] = useState<TemperatureUnit>(() => loadTemperatureUnitFromStorage());
  const [now, setNow] = useState<number>(() => Date.now());
  const [probeRanges, setProbeRanges] = useState<ProbeRanges>({});
  const [rangeDrafts, setRangeDrafts] = useState<ProbeRangeDrafts>({});
  const [editingRangeFor, setEditingRangeFor] = useState<ProbeKey | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(UNIT_STORAGE_KEY, temperatureUnit);
  }, [temperatureUnit]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let isUnmounted = false;
    let lastMessageAt = Date.now();

    const applyIncomingData = (newData: ProbesData) => {
      const timestamp = Date.now();

      setHistory((previousHistory) => {
        const nextHistory: ProbeHistory = {
          probe1: [...previousHistory.probe1],
          probe2: [...previousHistory.probe2],
          probe3: [...previousHistory.probe3],
          probe4: [...previousHistory.probe4]
        };

        PROBE_KEYS.forEach((probeKey) => {
          const currentValue = newData[probeKey];
          if (currentValue === null) {
            return;
          }

          nextHistory[probeKey] = [...previousHistory[probeKey], { timestamp, value: currentValue }];
        });

        return nextHistory;
      });

      setData(newData);
    };

    const fetchSnapshot = async () => {
      try {
        const response = await fetch('http://localhost:8000/state');
        if (!response.ok) {
          return;
        }

        const snapshot = await response.json() as ProbesData;
        applyIncomingData(snapshot);
      } catch {
        // Ignore snapshot errors; websocket reconnect loop remains primary
      }
    };

    const startWatchdog = () => {
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
      }

      watchdogTimer = setInterval(() => {
        const staleForMs = Date.now() - lastMessageAt;
        if (staleForMs < WS_STALE_MS) {
          return;
        }

        console.warn(`WebSocket stream stale for ${Math.round(staleForMs / 1000)}s. Refreshing connection...`);
        void fetchSnapshot();
        ws?.close();
      }, WS_WATCHDOG_MS);
    };

    const connect = () => {
      if (isUnmounted) {
        return;
      }

      ws = new WebSocket('ws://localhost:8000/ws');
      startWatchdog();

      ws.onopen = () => {
        lastMessageAt = Date.now();
      };

      ws.onmessage = (event) => {
        const newData = JSON.parse(event.data) as ProbesData;
        lastMessageAt = Date.now();
        applyIncomingData(newData);
      };

      ws.onclose = () => {
        if (isUnmounted) {
          return;
        }

        if (watchdogTimer) {
          clearInterval(watchdogTimer);
          watchdogTimer = null;
        }

        console.log('WebSocket disconnected. Retrying in 2s...');
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      isUnmounted = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
      }
      ws?.close();
    };
  }, []);

  const resetProbeHistory = (probeKey: ProbeKey) => {
    setHistory((previousHistory) => ({
      ...previousHistory,
      [probeKey]: []
    }));
  };

  const resetAllProbeHistory = () => {
    setHistory(emptyProbeHistory());
  };

  const openRangeEditor = (probeKey: ProbeKey) => {
    const existingRange = probeRanges[probeKey];

    setRangeDrafts((previousDrafts) => ({
      ...previousDrafts,
      [probeKey]: {
        min: existingRange ? convertTemperature(existingRange.min, temperatureUnit).toFixed(1) : '',
        max: existingRange ? convertTemperature(existingRange.max, temperatureUnit).toFixed(1) : ''
      }
    }));

    setEditingRangeFor(probeKey);
  };

  const updateRangeDraft = (probeKey: ProbeKey, field: 'min' | 'max', value: string) => {
    setRangeDrafts((previousDrafts) => ({
      ...previousDrafts,
      [probeKey]: {
        min: field === 'min' ? value : previousDrafts[probeKey]?.min ?? '',
        max: field === 'max' ? value : previousDrafts[probeKey]?.max ?? ''
      }
    }));
  };

  const saveRange = (probeKey: ProbeKey) => {
    const draft = rangeDrafts[probeKey];
    const minInput = draft?.min.trim() ?? '';
    const maxInput = draft?.max.trim() ?? '';

    if (!minInput || !maxInput) {
      window.alert('Please enter both minimum and maximum temperatures.');
      return;
    }

    const minRaw = Number(minInput);
    const maxRaw = Number(maxInput);

    if (!Number.isFinite(minRaw) || !Number.isFinite(maxRaw) || minRaw >= maxRaw) {
      window.alert('Please enter a valid range where minimum is less than maximum.');
      return;
    }

    const min = toCelsius(minRaw, temperatureUnit);
    const max = toCelsius(maxRaw, temperatureUnit);

    setProbeRanges((previousRanges) => ({
      ...previousRanges,
      [probeKey]: { min, max }
    }));

    setEditingRangeFor(null);
  };

  const cancelRangeEdit = () => {
    setEditingRangeFor(null);
  };

  const renderProbe = (name: string, key: ProbeKey) => {
    const samples = history[key];
    const lastSample = getLastProbeSample(samples);
    const latestValue = lastSample?.value ?? null;
    const isLive = Boolean(lastSample) && (now - (lastSample?.timestamp ?? 0) <= PROBE_LIVE_TIMEOUT_MS);
    const configuredRange = probeRanges[key];
    const isOutOfRange = Boolean(
      isLive &&
      latestValue !== null &&
      configuredRange &&
      (latestValue < configuredRange.min || latestValue > configuredRange.max)
    );
    const rangeLabel = configuredRange
      ? `${formatTemperature(configuredRange.min, temperatureUnit)} – ${formatTemperature(configuredRange.max, temperatureUnit)}`
      : 'Not set';
    const stats = getStats(samples);
    const chartBounds = getChartBounds(CHART_WIDTH, CHART_HEIGHT);
    const chartDomain = samples.length >= 2 ? getChartDomain(samples) : null;
    const chartPoints = chartDomain ? buildPolylinePoints(samples, chartBounds, chartDomain) : '';
    const xTicks = chartDomain ? buildTicks(chartDomain.startTs, chartDomain.endTs, X_TICK_COUNT) : [];
    const yTicks = chartDomain ? buildTicks(chartDomain.minValue, chartDomain.maxValue, Y_TICK_COUNT) : [];

    return (
      <section className={`probe-card ${!isLive ? 'disconnected' : ''} ${isOutOfRange ? 'out-of-range' : ''}`}>
        <div className="probe-header">
          <h2>{name}</h2>
          <div className="probe-actions">
            <button className="range-button" onClick={() => openRangeEditor(key)}>
              Set Range
            </button>
            <button className="reset-button" onClick={() => resetProbeHistory(key)}>
              Reset
            </button>
            <span className={`probe-pill ${isLive ? 'online' : 'offline'}`}>
              {isLive ? 'Live' : 'Offline'}
            </span>
          </div>
        </div>

        <div className="temp-display">{formatTemperature(isLive ? latestValue : null, temperatureUnit)}</div>
        <div className="range-summary">Range: {rangeLabel}</div>

        {editingRangeFor === key && (
          <div className="range-editor">
            <label>
              Min ({unitSymbol(temperatureUnit)})
              <input
                type="number"
                step="0.1"
                value={rangeDrafts[key]?.min ?? ''}
                onChange={(event) => updateRangeDraft(key, 'min', event.target.value)}
              />
            </label>
            <label>
              Max ({unitSymbol(temperatureUnit)})
              <input
                type="number"
                step="0.1"
                value={rangeDrafts[key]?.max ?? ''}
                onChange={(event) => updateRangeDraft(key, 'max', event.target.value)}
              />
            </label>
            <div className="range-editor-actions">
              <button className="range-save-button" onClick={() => saveRange(key)}>
                Save
              </button>
              <button className="range-cancel-button" onClick={cancelRangeEdit}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="chart-wrap">
          {samples.length >= 2 ? (
            <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" aria-label={`${name} temperature history`}>
              <defs>
                <linearGradient id={`${key}-line`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" />
                  <stop offset="100%" stopColor="#6366f1" />
                </linearGradient>
              </defs>
              <line className="chart-axis" x1={chartBounds.left} y1={chartBounds.top} x2={chartBounds.left} y2={chartBounds.bottom} />
              <line className="chart-axis" x1={chartBounds.left} y1={chartBounds.bottom} x2={chartBounds.right} y2={chartBounds.bottom} />
              {xTicks.map((tick, index) => {
                const xRatio = (tick - chartDomain!.startTs) / (chartDomain!.endTs - chartDomain!.startTs);
                const x = chartBounds.left + xRatio * (chartBounds.right - chartBounds.left);

                return (
                  <g key={`x-tick-${index}`}>
                    <line className="chart-tick" x1={x} y1={chartBounds.bottom} x2={x} y2={chartBounds.bottom + 4} />
                    <text className="chart-label" x={x} y={chartBounds.bottom + 16} textAnchor="middle">
                      {formatElapsedTick(tick - chartDomain!.startTs)}
                    </text>
                  </g>
                );
              })}
              {yTicks.map((tick, index) => {
                const yRatio = (tick - chartDomain!.minValue) / (chartDomain!.maxValue - chartDomain!.minValue);
                const y = chartBounds.bottom - yRatio * (chartBounds.bottom - chartBounds.top);

                return (
                  <g key={`y-tick-${index}`}>
                    <line className="chart-tick" x1={chartBounds.left - 4} y1={y} x2={chartBounds.left} y2={y} />
                    <text className="chart-label" x={chartBounds.left - 8} y={y + 3} textAnchor="end">
                      {formatAxisTemperature(tick, temperatureUnit)}
                    </text>
                  </g>
                );
              })}
              <polyline className="chart-line" points={chartPoints} stroke={`url(#${key}-line)`} />
            </svg>
          ) : (
            <div className="chart-empty">Waiting for enough samples…</div>
          )}
        </div>

        <div className="stats-grid">
          <div className="stat-item">
            <span>Min</span>
            <strong>{stats ? formatTemperature(stats.min, temperatureUnit) : '—'}</strong>
          </div>
          <div className="stat-item">
            <span>Max</span>
            <strong>{stats ? formatTemperature(stats.max, temperatureUnit) : '—'}</strong>
          </div>
          <div className="stat-item">
            <span>Average</span>
            <strong>{stats ? formatTemperature(stats.avg, temperatureUnit) : '—'}</strong>
          </div>
          <div className="stat-item">
            <span>{stats ? stats.rateLabel : 'Rate'}</span>
            <strong>{stats ? formatRate(stats.rate, temperatureUnit) : '—'}</strong>
          </div>
          <div className="stat-item">
            <span>Tracked For</span>
            <strong>{stats ? stats.connectedFor : '—'}</strong>
          </div>
        </div>
      </section>
    );
  };

  const liveProbeCount = PROBE_KEYS.filter((key) => {
    const lastSample = getLastProbeSample(history[key]);
    if (!lastSample) {
      return false;
    }

    return now - lastSample.timestamp <= PROBE_LIVE_TIMEOUT_MS;
  }).length;

  const statusText = data.connected
    ? `Connected • ${liveProbeCount}/4 probes live`
    : data.connection_state === 'reconnecting' || Boolean(data.device_address)
      ? 'Reconnecting to TP25...'
      : 'Searching for TP25...';

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">ThermoPro Monitor</p>
          <h1>TP25 Probe Dashboard</h1>
        </div>
        <div className="header-controls">
          <button className="reset-all-button" onClick={resetAllProbeHistory}>
            Reset All
          </button>
          <button
            className={`unit-toggle ${temperatureUnit === 'f' ? 'fahrenheit' : 'celsius'}`}
            onClick={() => setTemperatureUnit((current) => (current === 'c' ? 'f' : 'c'))}
            aria-label={temperatureUnit === 'c' ? 'Switch to Fahrenheit' : 'Switch to Celsius'}
          >
            <span className="unit-toggle-knob" />
            <span className={`unit-toggle-label c ${temperatureUnit === 'c' ? 'active' : ''}`}>°C</span>
            <span className={`unit-toggle-label f ${temperatureUnit === 'f' ? 'active' : ''}`}>°F</span>
          </button>

          <div className={`status-indicator ${data.connected ? 'online' : 'offline'}`}>
            {statusText}
          </div>
        </div>
      </header>

      <main className="probe-grid">
        {renderProbe('Probe 1', 'probe1')}
        {renderProbe('Probe 2', 'probe2')}
        {renderProbe('Probe 3', 'probe3')}
        {renderProbe('Probe 4', 'probe4')}
      </main>
    </div>
  )
}

export default App
