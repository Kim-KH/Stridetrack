import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, 
  Square, 
  History, 
  Settings as SettingsIcon, 
  TrendingUp, 
  MapPin, 
  Timer, 
  Footprints,
  Volume2,
  VolumeX,
  ChevronLeft,
  Calendar
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  BarChart, 
  Bar
} from 'recharts';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  format, 
  startOfWeek, 
  endOfWeek, 
  eachDayOfInterval, 
  isSameDay, 
  subDays, 
  startOfMonth, 
  endOfMonth,
  startOfYear,
  endOfYear
} from 'date-fns';

// --- Utils (외부 파일 의존성 제거를 위해 cn 함수 내장) ---
function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(' ');
}

// --- Types ---
interface Run {
  id: number;
  distance: number; 
  duration: number; 
  steps: number;
  timestamp: string;
}

interface Stats {
  daily: { date: string; distance: number; steps: number }[];
  weekly: { week: string; distance: number; steps: number }[];
  monthly: { month: string; distance: number; steps: number }[];
  yearly: { year: string; distance: number; steps: number }[];
}

type View = 'dashboard' | 'active-run' | 'history' | 'stats' | 'settings';

// --- Constants ---
const ALERT_INTERVALS = [500, 1000, 2000, 3000, 4000, 5000, 10000];

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const [isTracking, setIsTracking] = useState(false);
  const [distance, setDistance] = useState(0); 
  const [duration, setDuration] = useState(0); 
  const [steps, setSteps] = useState(0);
  const [lastAlertDistance, setLastAlertDistance] = useState(0);
  const [runs, setRuns] = useState<Run[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [gpsStatus, setGpsStatus] = useState<'searching' | 'active' | 'error'>('searching');
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [alertInterval, setAlertInterval] = useState(1000); 
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const wakeLock = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const watchId = useRef<number | null>(null);
  const lastPosition = useRef<GeolocationCoordinates | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const lastStepTime = useRef<number>(0);

  // --- [Data Logic] 서버 기능을 대체하는 로컬 데이터 처리 (전체 로직 구현) ---

  const calculateStatsLocally = (allRuns: Run[]) => {
    const now = new Date();
    
    // 1. Daily Stats (Last 7 Days)
    const daily = Array.from({ length: 7 }).map((_, i) => {
      const d = subDays(now, i);
      const dayRuns = allRuns.filter(r => isSameDay(new Date(r.timestamp), d));
      return {
        date: format(d, 'yyyy-MM-dd'),
        distance: dayRuns.reduce((sum, r) => sum + r.distance, 0),
        steps: dayRuns.reduce((sum, r) => sum + r.steps, 0)
      };
    });

    // 2. Weekly Stats (Last 4 Weeks)
    const weekly = Array.from({ length: 4 }).map((_, i) => {
      const d = subDays(now, i * 7);
      const start = startOfWeek(d);
      const end = endOfWeek(d);
      const weekRuns = allRuns.filter(r => {
        const rDate = new Date(r.timestamp);
        return rDate >= start && rDate <= end;
      });
      return {
        week: `${format(start, 'MM/dd')}`,
        distance: weekRuns.reduce((sum, r) => sum + r.distance, 0),
        steps: weekRuns.reduce((sum, r) => sum + r.steps, 0)
      };
    });

    // 3. Monthly Stats (Last 6 Months)
    const monthly = Array.from({ length: 6 }).map((_, i) => {
      const d = startOfMonth(subDays(now, i * 30));
      const monthRuns = allRuns.filter(r => {
        const rDate = new Date(r.timestamp);
        return rDate >= startOfMonth(d) && rDate <= endOfMonth(d);
      });
      return {
        month: format(d, 'MMM'),
        distance: monthRuns.reduce((sum, r) => sum + r.distance, 0),
        steps: monthRuns.reduce((sum, r) => sum + r.steps, 0)
      };
    });

    // 4. Yearly Stats
    const yearly = [{
      year: format(now, 'yyyy'),
      distance: allRuns.filter(r => new Date(r.timestamp).getFullYear() === now.getFullYear())
                       .reduce((sum, r) => sum + r.distance, 0),
      steps: allRuns.filter(r => new Date(r.timestamp).getFullYear() === now.getFullYear())
                    .reduce((sum, r) => sum + r.steps, 0)
    }];

    setStats({ daily, weekly, monthly, yearly });
  };

  const fetchRuns = async () => {
    try {
      const saved = localStorage.getItem('stridetrack_runs');
      const allRuns = saved ? JSON.parse(saved) : [];
      setRuns(allRuns);
      return allRuns;
    } catch (e) {
      console.error("Failed to load runs", e);
      return [];
    }
  };

  const fetchStats = async () => {
    try {
      const saved = localStorage.getItem('stridetrack_runs');
      const allRuns = saved ? JSON.parse(saved) : [];
      calculateStatsLocally(allRuns);
    } catch (e) {
      console.error("Failed to calculate stats", e);
    }
  };

  const saveRun = async () => {
    try {
      const newRun: Run = {
        id: Date.now(),
        distance,
        duration,
        steps,
        timestamp: new Date().toISOString(),
      };
      const updatedRuns = [newRun, ...runs];
      setRuns(updatedRuns);
      localStorage.setItem('stridetrack_runs', JSON.stringify(updatedRuns));
      calculateStatsLocally(updatedRuns);
    } catch (e) {
      console.error("Failed to save run", e);
    }
  };

  // --- [Core Logic] GPS, Motion, 오디오 루프 (원본 유지) ---

  useEffect(() => {
    fetchRuns();
    fetchStats();
    
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(console.error);
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    });

    if (typeof (DeviceMotionEvent as any)?.requestPermission === 'function') {
      (DeviceMotionEvent as any).requestPermission();
    }
  }, []);

  useEffect(() => {
    if (isTracking) {
      startTracking();
      window.addEventListener('devicemotion', handleMotion);
    } else {
      stopTracking();
      window.removeEventListener('devicemotion', handleMotion);
    }
    return () => {
      stopTracking();
      window.removeEventListener('devicemotion', handleMotion);
    };
  }, [isTracking]);

  const handleMotion = (event: DeviceMotionEvent) => {
    const acc = event.accelerationIncludingGravity;
    if (!acc) return;
    const totalAcc = Math.sqrt((acc.x || 0)**2 + (acc.y || 0)**2 + (acc.z || 0)**2);
    const now = Date.now();
    if (totalAcc > 13 && now - lastStepTime.current > 300) {
      setSteps(prev => prev + 1);
      lastStepTime.current = now;
      if (gpsAccuracy && gpsAccuracy > 20) { 
        setDistance(prev => prev + 0.7);
      }
    }
  };

  const startSilentAudio = () => {
    if (!audioRef.current) {
      const silentSrc = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
      audioRef.current = new Audio(silentSrc);
      audioRef.current.loop = true;
    }
    audioRef.current.play().catch(e => console.log("Audio play failed:", e));
  };

  const stopSilentAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  };

  const startTracking = () => {
    startSilentAudio();
    setDistance(0); setDuration(0); setSteps(0); setLastAlertDistance(0);
    setGpsStatus('searching');
    lastPosition.current = null;

    timerRef.current = setInterval(() => {
      setDuration(prev => prev + 1);
    }, 1000);

    if ("geolocation" in navigator) {
      watchId.current = navigator.geolocation.watchPosition(
        (position) => {
          setGpsStatus('active');
          setGpsAccuracy(position.coords.accuracy);
          if (lastPosition.current) {
            const d = calculateDistance(
              lastPosition.current.latitude, lastPosition.current.longitude,
              position.coords.latitude, position.coords.longitude
            );
            if (d > 1 && position.coords.accuracy < 50) {
              setDistance(prev => prev + d);
            }
          }
          lastPosition.current = position.coords;
        },
        (err) => {
          setGpsStatus('error');
          setErrorMsg(`GPS Error: ${err.message}`);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
      );
    }
  };

  const stopTracking = () => {
    stopSilentAudio();
    if (watchId.current) navigator.geolocation.clearWatch(watchId.current);
    if (timerRef.current) clearInterval(timerRef.current);
    watchId.current = null; timerRef.current = null;
  };

  const handleFinish = () => {
    saveRun();
    setIsTracking(false);
    setView('dashboard');
  };

  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180; const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180; const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
  };

  const playAlert = (dist: number) => {
    if (!audioEnabled) return;
    const utterance = new SpeechSynthesisUtterance(`${(dist / 1000).toFixed(1)} kilometers reached.`);
    window.speechSynthesis.speak(utterance);
  };

  useEffect(() => {
    if (isTracking && audioEnabled) {
      const diff = distance - lastAlertDistance;
      if (diff >= alertInterval) {
        playAlert(distance);
        setLastAlertDistance(Math.floor(distance / alertInterval) * alertInterval);
      }
    }
  }, [distance, isTracking, audioEnabled, alertInterval, lastAlertDistance]);

  // --- [Render Helpers] 모든 UI 컴포넌트 복원 ---

  const renderDashboard = () => (
    <div className="p-6 space-y-8">
      <div className="flex justify-between items-center">
        <div><h1 className="text-3xl font-bold text-slate-900">StrideTrack</h1><p className="text-slate-500">Ready for a run?</p></div>
        <button onClick={() => setView('settings')} className="p-2 rounded-full bg-slate-100 text-slate-600"><SettingsIcon size={24} /></button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-emerald-50 p-4 rounded-2xl border border-emerald-100">
          <div className="flex items-center gap-2 text-emerald-600 mb-1"><TrendingUp size={16} /><span className="text-xs font-semibold uppercase">Today</span></div>
          <p className="text-2xl font-bold text-slate-900">{((stats?.daily[0]?.distance || 0) / 1000).toFixed(2)} <span className="text-sm font-normal text-slate-500">km</span></p>
        </div>
        <div className="bg-indigo-50 p-4 rounded-2xl border border-indigo-100">
          <div className="flex items-center gap-2 text-indigo-600 mb-1"><Footprints size={16} /><span className="text-xs font-semibold uppercase">Steps</span></div>
          <p className="text-2xl font-bold text-slate-900">{stats?.daily[0]?.steps || 0}</p>
        </div>
      </div>

      <div className="flex flex-col items-center justify-center py-12">
        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => { setIsTracking(true); setView('active-run'); }} className="w-40 h-40 rounded-full bg-emerald-500 shadow-xl shadow-emerald-200 flex flex-col items-center justify-center text-white gap-2">
          <Play size={48} fill="currentColor" /><span className="font-bold text-lg">START</span>
        </motion.button>
      </div>

      <div className="space-y-4">
        <div className="flex justify-between items-center"><h2 className="text-lg font-bold">Recent Runs</h2><button onClick={() => setView('history')} className="text-sm text-emerald-600 font-semibold">View All</button></div>
        <div className="space-y-3">
          {runs.slice(0, 3).map(run => (
            <div key={run.id} className="bg-white p-4 rounded-xl border border-slate-100 flex justify-between items-center shadow-sm">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-slate-50 flex items-center justify-center text-slate-400"><MapPin size={20} /></div>
                <div><p className="font-bold text-slate-900">{(run.distance / 1000).toFixed(2)} km</p><p className="text-xs text-slate-500">{format(new Date(run.timestamp), 'MMM d, h:mm a')}</p></div>
              </div>
              <div className="text-right"><p className="text-sm font-medium text-slate-700">{formatTime(run.duration)}</p><p className="text-xs text-slate-400">{run.steps} steps</p></div>
            </div>
          ))}
          {runs.length === 0 && <p className="text-center text-slate-400 py-4">No runs yet.</p>}
        </div>
      </div>
    </div>
  );

  const renderActiveRun = () => (
    <div className="h-full flex flex-col bg-slate-900 text-white p-8">
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-2">
          <div className={cn("w-2 h-2 rounded-full animate-pulse", gpsStatus === 'active' ? "bg-emerald-500" : gpsStatus === 'searching' ? "bg-amber-500" : "bg-rose-500")} />
          <span className="text-[10px] font-bold uppercase text-slate-400">{gpsStatus === 'active' ? `GPS Active (${gpsAccuracy?.toFixed(0)}m)` : 'Searching...'}</span>
        </div>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center space-y-12">
        <div className="text-center"><p className="text-slate-400 text-sm mb-2">Distance</p><h2 className="text-8xl font-black">{(distance / 1000).toFixed(2)}</h2><p className="text-2xl font-bold text-emerald-400">KILOMETERS</p></div>
        <div className="grid grid-cols-2 w-full gap-8">
          <div className="text-center"><Timer size={18} className="mx-auto mb-1 text-slate-400" /><p className="text-3xl font-bold">{formatTime(duration)}</p></div>
          <div className="text-center"><Footprints size={18} className="mx-auto mb-1 text-slate-400" /><p className="text-3xl font-bold">{steps}</p></div>
        </div>
      </div>
      <div className="flex gap-4 pb-8">
        <button onClick={() => setAudioEnabled(!audioEnabled)} className={cn("p-4 rounded-2xl", audioEnabled ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-800 text-slate-500")}><Volume2 size={24} /></button>
        <button onClick={handleFinish} className="flex-1 bg-rose-500 font-bold py-4 rounded-2xl flex items-center justify-center gap-2">FINISH RUN</button>
      </div>
    </div>
  );

  const renderHistory = () => (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4"><button onClick={() => setView('dashboard')} className="p-2 rounded-lg bg-slate-100"><ChevronLeft size={20} /></button><h1 className="text-2xl font-bold">Run History</h1></div>
      <div className="space-y-4">
        {runs.map(run => (
          <div key={run.id} className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm">
            <div className="flex justify-between mb-4">
              <div><p className="text-sm text-slate-500">{format(new Date(run.timestamp), 'EEEE, MMMM d')}</p><p className="text-xs text-slate-400">{format(new Date(run.timestamp), 'h:mm a')}</p></div>
            </div>
            <div className="grid grid-cols-3 gap-4 border-t pt-4 text-center">
              <div><p className="text-xs text-slate-400 font-bold uppercase">Dist</p><p className="font-bold">{(run.distance / 1000).toFixed(2)}km</p></div>
              <div><p className="text-xs text-slate-400 font-bold uppercase">Time</p><p className="font-bold">{formatTime(run.duration)}</p></div>
              <div><p className="text-xs text-slate-400 font-bold uppercase">Steps</p><p className="font-bold">{run.steps}</p></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderStats = () => {
    const [statTab, setStatTab] = useState<'day' | 'week' | 'month'>('day');
    const chartData = statTab === 'day' ? stats?.daily : statTab === 'week' ? stats?.weekly : stats?.monthly;
    const formattedData = chartData?.map(d => ({
      name: (d as any).date || (d as any).week || (d as any).month,
      distance: Number(((d.distance || 0) / 1000).toFixed(2)),
      steps: d.steps || 0
    })).reverse();

    return (
      <div className="p-6 space-y-6 pb-24">
        <div className="flex items-center gap-4"><button onClick={() => setView('dashboard')} className="p-2 rounded-lg bg-slate-100"><ChevronLeft size={20} /></button><h1 className="text-2xl font-bold">Statistics</h1></div>
        <div className="flex p-1 bg-slate-100 rounded-xl">
          {['day', 'week', 'month'].map(tab => (
            <button key={tab} onClick={() => setStatTab(tab as any)} className={cn("flex-1 py-2 text-xs font-bold rounded-lg capitalize", statTab === tab ? "bg-white text-emerald-600 shadow-sm" : "text-slate-500")}>{tab}</button>
          ))}
        </div>
        <div className="bg-white p-4 rounded-2xl border shadow-sm">
          <h3 className="text-sm font-bold mb-6">Distance (km)</h3>
          <div className="h-64 w-full"><ResponsiveContainer><BarChart data={formattedData}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" tick={{fontSize: 10}} /><YAxis tick={{fontSize: 10}} /><Tooltip /><Bar dataKey="distance" fill="#10b981" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div>
        </div>
        <div className="bg-white p-4 rounded-2xl border shadow-sm">
          <h3 className="text-sm font-bold mb-6">Steps</h3>
          <div className="h-64 w-full"><ResponsiveContainer><LineChart data={formattedData}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" tick={{fontSize: 10}} /><YAxis tick={{fontSize: 10}} /><Tooltip /><Line type="monotone" dataKey="steps" stroke="#6366f1" strokeWidth={3} dot={{r: 4}} /></LineChart></ResponsiveContainer></div>
        </div>
      </div>
    );
  };

  const renderSettings = () => (
    <div className="p-6 space-y-8">
      <div className="flex items-center gap-4"><button onClick={() => setView('dashboard')} className="p-2 rounded-lg bg-slate-100"><ChevronLeft size={20} /></button><h1 className="text-2xl font-bold">Settings</h1></div>
      <div className="space-y-6">
        <div className="bg-white p-6 rounded-2xl border shadow-sm flex justify-between items-center">
          <div><p className="font-bold">Audio Alerts</p><p className="text-xs text-slate-500">Voice feedback during run</p></div>
          <button onClick={() => setAudioEnabled(!audioEnabled)} className={cn("w-12 h-6 rounded-full transition-colors relative", audioEnabled ? "bg-emerald-500" : "bg-slate-200")}><div className={cn("absolute top-1 w-4 h-4 bg-white rounded-full transition-all", audioEnabled ? "left-7" : "left-1")} /></button>
        </div>
        <div className="bg-white p-6 rounded-2xl border shadow-sm">
          <p className="font-bold mb-4">Installation</p>
          {deferredPrompt ? (
            <button onClick={() => deferredPrompt.prompt()} className="w-full bg-emerald-600 text-white font-bold py-3 rounded-xl">Install StrideTrack App</button>
          ) : <p className="text-xs text-slate-400">App is ready or already installed.</p>}
        </div>
      </div>
    </div>
  );

  return (
    <div className="max-w-md mx-auto h-screen bg-slate-50 overflow-y-auto font-sans relative">
      <AnimatePresence mode="wait">
        <motion.div key={view} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="h-full">
          {view === 'dashboard' && renderDashboard()}
          {view === 'active-run' && renderActiveRun()}
          {view === 'history' && renderHistory()}
          {view === 'stats' && renderStats()}
          {view === 'settings' && renderSettings()}
        </motion.div>
      </AnimatePresence>
      {view !== 'active-run' && (
        <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white/80 backdrop-blur-md border-t px-6 py-3 flex justify-between items-center">
          <button onClick={() => setView('dashboard')} className={cn("p-2 flex flex-col items-center", view === 'dashboard' ? "text-emerald-600" : "text-slate-400")}><Play size={20} /><span className="text-[10px] font-bold">RUN</span></button>
          <button onClick={() => setView('stats')} className={cn("p-2 flex flex-col items-center", view === 'stats' ? "text-emerald-600" : "text-slate-400")}><TrendingUp size={20} /><span className="text-[10px] font-bold">STATS</span></button>
          <button onClick={() => setView('history')} className={cn("p-2 flex flex-col items-center", view === 'history' ? "text-emerald-600" : "text-slate-400")}><History size={20} /><span className="text-[10px] font-bold">HISTORY</span></button>
          <button onClick={() => setView('settings')} className={cn("p-2 flex flex-col items-center", view === 'settings' ? "text-emerald-600" : "text-slate-400")}><SettingsIcon size={20} /><span className="text-[10px] font-bold">SETTINGS</span></button>
        </div>
      )}
    </div>
  );
}