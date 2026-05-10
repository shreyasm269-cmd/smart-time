import React, { useState, useEffect, useRef, useMemo } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { 
  collection, 
  query, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  doc, 
  deleteDoc, 
  orderBy, 
  serverTimestamp,
  getDoc,
  setDoc
} from 'firebase/firestore';
import { format, startOfWeek, endOfWeek, addDays, addMonths, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isToday, isSameMonth, parseISO, addHours, differenceInMinutes } from 'date-fns';
import { 
  Calendar as CalendarIcon, 
  Plus, 
  CheckCircle2, 
  Clock, 
  MessageSquare, 
  ChevronLeft, 
  ChevronRight,
  LogOut, 
  LayoutDashboard, 
  BookOpen, 
  AlertCircle,
  AlertTriangle,
  MoreVertical,
  Send,
  User as UserIcon,
  Search,
  Target,
  MoreHorizontal,
  CalendarDays,
  X,
  Layers,
  Columns,
  Rows
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast, Toaster } from 'react-hot-toast';
import ReactMarkdown from 'react-markdown';

import { auth, db, signInWithGoogle, handleFirestoreError, OperationType } from './lib/firebase';
import { cn } from './lib/utils';
import { ScheduleEvent, Assignment, ChatMessage, UserProfile, EventType, AssignmentStatus } from './types';
import { chatWithAssistant } from './services/geminiService';

// --- Components ---

const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }>(
  ({ className, variant = 'primary', ...props }, ref) => {
    const variants = {
      primary: 'bg-blue-600 text-white hover:bg-blue-700 shadow-[0_0_15px_rgba(37,99,235,0.2)]',
      secondary: 'bg-zinc-800 text-zinc-100 border border-zinc-700 hover:bg-zinc-700 hover:border-zinc-600',
      ghost: 'bg-transparent text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100',
      danger: 'bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500 hover:text-white'
    };
    return (
      <button
        ref={ref}
        className={cn('px-4 py-2 rounded-xl font-medium transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2', variants[variant], className)}
        {...props}
      />
    );
  }
);

const Card = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn('bento-card', className)}>
    {children}
  </div>
);

// --- Main App ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'calendar' | 'assignments' | 'chat'>('dashboard');
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [pendingConflict, setPendingConflict] = useState<{ newEvent: any, existingEvent: ScheduleEvent } | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  const expandRecurringEvents = (events: ScheduleEvent[], rangeStart: Date, rangeEnd: Date): ScheduleEvent[] => {
    const expanded: ScheduleEvent[] = [];
    
    events.forEach(event => {
      // Base occurrence
      expanded.push(event);

      if (!event.recurrence || event.recurrence.frequency === 'none') return;

      const { frequency, daysOfWeek, until } = event.recurrence;
      const start = parseISO(event.startTime);
      const end = parseISO(event.endTime);
      const duration = end.getTime() - start.getTime();
      const limit = until ? parseISO(until) : addDays(rangeEnd, 7); // Default limit is end of range + 1 week

      let current = start;

      // Skip the first occurrence as it's already added
      const increment = () => {
        if (frequency === 'daily') current = addDays(current, 1);
        else if (frequency === 'weekly') current = addDays(current, 7);
        else if (frequency === 'monthly') current = addDays(current, 30); // Simplified monthly
      };

      increment();

      while (current <= limit && current <= rangeEnd) {
        if (daysOfWeek && daysOfWeek.length > 0) {
          // For weekly/daily with specific days, we might need more complex logic, 
          // but let's stick to simple version for now where frequency defines the step
          // and daysOfWeek filters (if weekly)
          if (frequency === 'weekly' && !daysOfWeek.includes(current.getDay())) {
            current = addDays(current, 1);
            continue;
          }
        }

        const newStart = new Date(current);
        const newEnd = new Date(current.getTime() + duration);

        expanded.push({
          ...event,
          id: `${event.id}-occ-${current.getTime()}`,
          startTime: newStart.toISOString(),
          endTime: newEnd.toISOString(),
        });

        increment();
      }
    });

    return expanded;
  };

  const expandedEvents = useMemo(() => {
    // For general UI (Dashboard and current Month view)
    // Expand from slightly before now (to catch ongoing events) to 3 months ahead
    const rangeStart = startOfMonth(addDays(new Date(), -7));
    const rangeEnd = endOfMonth(addDays(selectedDate, 60)); 
    return expandRecurringEvents(events, rangeStart, rangeEnd);
  }, [events, selectedDate]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setLoading(false);
      if (u) {
        // Ensure user profile exists
        const userRef = doc(db, 'users', u.uid);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) {
          await setDoc(userRef, {
            uid: u.uid,
            email: u.email,
            displayName: u.displayName,
            preferences: {
              dailyStartHour: 8,
              dailyEndHour: 20,
              defaultStudyDuration: 60
            }
          });
        }
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user) return;

    const eventsRef = collection(db, 'users', user.uid, 'events');
    const assignmentsRef = collection(db, 'users', user.uid, 'assignments');
    const messagesRef = collection(db, 'users', user.uid, 'messages');

    const unsubEvents = onSnapshot(query(eventsRef, orderBy('startTime')), (snap) => {
      setEvents(snap.docs.map(d => ({ id: d.id, ...d.data() } as ScheduleEvent)));
    }, err => handleFirestoreError(err, OperationType.GET, 'events'));

    const unsubAssignments = onSnapshot(query(assignmentsRef, orderBy('dueDate')), (snap) => {
      setAssignments(snap.docs.map(d => ({ id: d.id, ...d.data() } as Assignment)));
    }, err => handleFirestoreError(err, OperationType.GET, 'assignments'));

    const unsubMessages = onSnapshot(query(messagesRef, orderBy('timestamp', 'asc')), (snap) => {
      setMessages(snap.docs.map(d => ({ id: d.id, ...d.data() } as ChatMessage)));
    }, err => handleFirestoreError(err, OperationType.GET, 'messages'));

    return () => {
      unsubEvents();
      unsubAssignments();
      unsubMessages();
    };
  }, [user]);

  const handleSendMessage = async (inputOverride?: string) => {
    const textToSend = inputOverride || chatInput;
    if (!textToSend.trim() || !user) return;

    const userMessage: ChatMessage = {
      text: textToSend,
      role: 'user',
      timestamp: new Date().toISOString()
    };

    if (!inputOverride) setChatInput('');
    setIsChatLoading(true);

    try {
      // Save user message (don't save automated messages to clutter history if desired, but here we will for transparency)
      await addDoc(collection(db, 'users', user.uid, 'messages'), userMessage);

      // Context for AI - send next 14 days of expanded events to be safe
      const aiContextStart = new Date();
      const aiContextEnd = addDays(aiContextStart, 14);
      const contextualEvents = expandRecurringEvents(events, aiContextStart, aiContextEnd);

      const context = JSON.stringify({
        today: new Date().toISOString(),
        events: contextualEvents.map(e => ({ title: e.title, type: e.type, startTime: e.startTime, endTime: e.endTime, recurrence: e.recurrence })),
        assignments: assignments.filter(a => a.status !== 'completed'),
      });

      const geminiMessages = messages.slice(-10).map(m => ({
        role: m.role,
        parts: [{ text: m.text }]
      }));
      geminiMessages.push({ role: 'user', parts: [{ text: textToSend }] });

      const response = await chatWithAssistant(geminiMessages, context);
      
      if (response.text) {
        await addDoc(collection(db, 'users', user.uid, 'messages'), {
          text: response.text,
          role: 'model',
          timestamp: new Date().toISOString()
        });
      }

      // Handle tool calls
      if (response.functionCalls) {
        for (const call of response.functionCalls) {
          if (call.name === 'createEvent') {
            const conflict = getConflict(call.args, contextualEvents);
            if (conflict) {
              setPendingConflict({ newEvent: call.args, existingEvent: conflict });
            } else {
              await addDoc(collection(db, 'users', user.uid, 'events'), call.args);
              toast.success(`Created event: ${call.args.title}`);
            }
          }
          if (call.name === 'createAssignment') {
            await addDoc(collection(db, 'users', user.uid, 'assignments'), {
              ...call.args,
              status: 'todo'
            });
            toast.success(`Added assignment: ${call.args.title}`);
          }
        }
      }
    } catch (error) {
      console.error(error);
      toast.error('Failed to communicate with system');
    } finally {
      setIsChatLoading(false);
    }
  };

  const handleAutoSchedule = () => {
    setActiveTab('chat');
    handleSendMessage("Analyze my current schedule and pending assignments. Automatically create optimal study sessions in my free blocks for the next 48 hours to help me stay on track.");
  };

  const getConflict = (event: Partial<ScheduleEvent>, existingEvents: ScheduleEvent[]) => {
    return existingEvents.find(other => {
      if (other.id === event.id) return false;
      const start1 = parseISO(event.startTime!);
      const end1 = parseISO(event.endTime!);
      const start2 = parseISO(other.startTime);
      const end2 = parseISO(other.endTime);
      return start1 < end2 && start2 < end1;
    });
  };

  const resolveConflict = async (action: 'keep' | 'reschedule_new' | 'reschedule_existing') => {
    if (!pendingConflict || !user) return;

    try {
      if (action === 'keep') {
        await addDoc(collection(db, 'users', user.uid, 'events'), pendingConflict.newEvent);
        toast.success("Scheduled despite conflict");
      } else if (action === 'reschedule_new') {
        setActiveTab('chat');
        handleSendMessage(`I want to schedule "${pendingConflict.newEvent.title}" but it conflicts with "${pendingConflict.existingEvent.title}" at ${format(parseISO(pendingConflict.existingEvent.startTime), 'HH:mm')}. Find another free slot for it.`);
      } else if (action === 'reschedule_existing') {
        setActiveTab('chat');
        handleSendMessage(`I have a conflict between my new event "${pendingConflict.newEvent.title}" and the existing "${pendingConflict.existingEvent.title}". Please move "${pendingConflict.existingEvent.title}" to a different time so I can fit the new one.`);
        await addDoc(collection(db, 'users', user.uid, 'events'), pendingConflict.newEvent);
      }
    } catch (error) {
      console.error(error);
      toast.error("Failed to resolve conflict");
    } finally {
      setPendingConflict(null);
    }
  };

  const toggleAssignmentStatus = async (a: Assignment) => {
    if (!user) return;
    const nextStatus: Record<string, string> = {
      'todo': 'in_progress',
      'in_progress': 'completed',
      'completed': 'todo'
    };
    await updateDoc(doc(db, 'users', user.uid, 'assignments', a.id!), {
      status: nextStatus[a.status] || 'todo'
    });
  };

  if (loading) return <div className="h-screen flex items-center justify-center bg-zinc-950"><motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1 }} className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" /></div>;

  if (!user) return <LoginView />;

  return (
    <div className="flex h-screen bg-zinc-950 font-sans text-zinc-50 overflow-hidden">
      <Toaster position="top-right" toastOptions={{ style: { background: '#18181b', color: '#fafafa', border: '1px solid #27272a' } }} />
      
      {/* Sidebar */}
      <aside className="w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col hidden md:flex">
        <div className="p-6 border-b border-zinc-800 flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-xl">
            T
          </div>
          <div>
            <h1 className="font-extrabold text-lg leading-tight tracking-tight uppercase">Smart<span className="text-blue-500">Flow</span></h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="status-dot bg-emerald-500"></span>
              <p className="text-[10px] text-zinc-500 font-bold tracking-widest uppercase">System Online</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          <NavItem icon={LayoutDashboard} label="Dashboard" active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} />
          <NavItem icon={CalendarIcon} label="Calendar" active={activeTab === 'calendar'} onClick={() => setActiveTab('calendar')} />
          <NavItem icon={BookOpen} label="Assignments" active={activeTab === 'assignments'} onClick={() => setActiveTab('assignments')} />
          <NavItem icon={MessageSquare} label="AI Assistant" active={activeTab === 'chat'} onClick={() => setActiveTab('chat')} />
        </nav>

        <div className="p-4 border-t border-zinc-800">
          <div className="bg-zinc-800/50 rounded-xl p-4 mb-4 border border-zinc-800">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Efficiency</p>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full" style={{ width: `${(assignments.filter(a => a.status === 'completed').length / (assignments.length || 1)) * 100}%` }} />
              </div>
              <span className="text-[10px] font-mono text-zinc-400">
                {Math.round((assignments.filter(a => a.status === 'completed').length / (assignments.length || 1)) * 100)}%
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3 px-2">
            <div className="w-8 h-8 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center overflow-hidden">
              {user.photoURL ? <img src={user.photoURL} alt="" /> : <UserIcon className="w-4 h-4 text-zinc-500" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate text-zinc-200">{user.displayName || 'Student'}</p>
              <button onClick={() => auth.signOut()} className="text-[10px] text-zinc-500 font-bold hover:text-red-500 transition-colors uppercase tracking-widest">
                Term. Session
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        <header className="h-16 bg-zinc-950/80 backdrop-blur-md border-b border-zinc-800 flex items-center justify-between px-8 z-10">
          <h2 className="text-xl font-extrabold flex items-center gap-2 uppercase tracking-tight">
            {activeTab}
          </h2>
          <div className="flex items-center gap-4">
            <div className="relative md:block hidden">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input type="text" placeholder="Search system..." className="pl-10 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-300 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 w-64 transition-all" />
            </div>
            <Button onClick={() => setIsAddModalOpen(true)} className="rounded-full px-4 text-xs font-bold uppercase tracking-widest">
              <Plus className="w-4 h-4" /> New Entry
            </Button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8 relative">
          {/* Subtle background gradient */}
          <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_50%_0%,rgba(37,99,235,0.05)_0%,transparent_50%)] pointer-events-none" />
          
          <AnimatePresence mode="wait">
            {activeTab === 'dashboard' && <DashboardView key="dash" events={expandedEvents} assignments={assignments} onAutoSchedule={handleAutoSchedule} onAdd={() => setIsAddModalOpen(true)} />}
            {activeTab === 'calendar' && <CalendarView key="cal" events={expandedEvents} selectedDate={selectedDate} setSelectedDate={setSelectedDate} />}
            {activeTab === 'assignments' && <AssignmentsView key="ass" assignments={assignments} toggleStatus={toggleAssignmentStatus} />}
            {activeTab === 'chat' && <ChatView key="chat" messages={messages} input={chatInput} setInput={setChatInput} onSend={() => handleSendMessage()} isLoading={isChatLoading} />}
          </AnimatePresence>

          <AddEntryModal 
            isOpen={isAddModalOpen} 
            onClose={() => setIsAddModalOpen(false)} 
            user={user} 
            events={expandedEvents} 
            onConflictDetected={setPendingConflict}
          />

          {/* Conflict Resolution Modal */}
          <AnimatePresence>
            {pendingConflict && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-zinc-950/80 backdrop-blur-md"
              >
                <motion.div 
                  initial={{ scale: 0.9, y: 20 }}
                  animate={{ scale: 1, y: 0 }}
                  className="bento-card bg-zinc-900 border-zinc-800 p-8 max-w-md w-full shadow-2xl relative overflow-hidden"
                >
                  <div className="absolute top-0 left-0 w-full h-1 bg-red-500 animate-pulse" />
                  
                  <div className="flex items-center gap-4 mb-6">
                    <div className="w-12 h-12 bg-red-500/20 rounded-2xl flex items-center justify-center text-red-500">
                      <AlertTriangle className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="text-xl font-extrabold uppercase tracking-tight">Scheduling Conflict</h3>
                      <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">ERROR_CODE: OVERLAP_DETECTED</p>
                    </div>
                  </div>

                  <div className="space-y-4 mb-8">
                    <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800">
                      <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest mb-1">New Intent</p>
                      <p className="text-sm font-bold text-zinc-200">{pendingConflict.newEvent.title}</p>
                      <p className="text-[10px] font-mono text-blue-400 mt-1">
                        {format(parseISO(pendingConflict.newEvent.startTime), 'HH:mm')} — {format(parseISO(pendingConflict.newEvent.endTime), 'HH:mm')}
                      </p>
                    </div>

                    <div className="flex justify-center">
                      <div className="w-px h-4 bg-zinc-800" />
                    </div>

                    <div className="p-4 rounded-xl bg-zinc-950 border border-red-500/20">
                      <p className="text-[9px] font-bold text-red-500/60 uppercase tracking-widest mb-1">Existing Block</p>
                      <p className="text-sm font-bold text-zinc-200">{pendingConflict.existingEvent.title}</p>
                      <p className="text-[10px] font-mono text-red-400 mt-1">
                        {format(parseISO(pendingConflict.existingEvent.startTime), 'HH:mm')} — {format(parseISO(pendingConflict.existingEvent.endTime), 'HH:mm')}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    <Button 
                      onClick={() => resolveConflict('reschedule_new')}
                      className="w-full bg-blue-600 hover:bg-blue-700 text-xs font-bold uppercase tracking-widest py-4"
                    >
                      Suggest New Time for "{pendingConflict.newEvent.title}"
                    </Button>
                    <Button 
                      variant="secondary"
                      onClick={() => resolveConflict('reschedule_existing')}
                      className="w-full border-zinc-800 text-[10px] font-bold uppercase tracking-widest"
                    >
                      Move "{pendingConflict.existingEvent.title}" Instead
                    </Button>
                    <div className="grid grid-cols-2 gap-3">
                      <Button 
                        variant="ghost"
                        onClick={() => resolveConflict('keep')}
                        className="text-[9px] font-bold uppercase tracking-widest text-zinc-500 hover:text-zinc-300"
                      >
                        Double Book
                      </Button>
                      <Button 
                        variant="ghost"
                        onClick={() => setPendingConflict(null)}
                        className="text-[9px] font-bold uppercase tracking-widest text-zinc-500 hover:text-red-400"
                      >
                        Abort
                      </Button>
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <footer className="h-10 bg-zinc-950 border-t border-zinc-800 flex items-center justify-between px-8 text-[10px] text-zinc-600 uppercase font-mono tracking-widest">
          <div>Status: Optimal</div>
          <div className="flex space-x-8">
            <span>Lat: 12ms</span>
            <span>Up: 99.9%</span>
          </div>
        </footer>
      </main>
    </div>
  );
}

function NavItem({ icon: Icon, label, active, onClick }: { icon: any, label: string, active: boolean, onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 font-medium group relative',
        active 
          ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' 
          : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
      )}
    >
      <Icon className={cn('w-5 h-5', active ? 'text-white' : 'text-zinc-500 group-hover:text-zinc-200')} />
      <span className="uppercase tracking-widest text-[11px] font-bold">{label}</span>
      {active && (
        <motion.div layoutId="active-pill" className="absolute left-0 w-1 h-6 bg-blue-400 rounded-r-full" />
      )}
    </button>
  );
}

function LoginView() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6 relative overflow-hidden">
      {/* Mesh gradients */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-blue-500/10 rounded-full blur-[120px]" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/10 rounded-full blur-[100px]" />
      
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="max-w-md w-full relative z-10 transition-all">
        <div className="bento-card p-12 text-center bg-zinc-900/50 backdrop-blur-xl">
          <div className="w-20 h-20 bg-blue-600 rounded-3xl flex items-center justify-center text-white mx-auto mb-8 shadow-[0_0_50px_rgba(37,99,235,0.3)] border border-blue-400/20">
            <Clock className="w-10 h-10" />
          </div>
          <h1 className="text-4xl font-extrabold text-white mb-2 tracking-tighter uppercase">Smart<span className="text-blue-500">Flow</span></h1>
          <p className="text-zinc-500 mb-10 text-sm font-medium leading-relaxed max-w-[280px] mx-auto">
            Autonomous academic scheduling and productivity synchronization.
          </p>
          
          <div className="space-y-4">
            <Button 
              onClick={signInWithGoogle} 
              className="w-full py-4 text-sm font-bold uppercase tracking-widest border border-blue-500/20"
            >
              Initialize Node
            </Button>
            <div className="flex items-center justify-between text-[10px] font-mono text-zinc-600 px-2 uppercase">
              <span>Secure Shell v2.4</span>
              <span>Encrypted Access</span>
            </div>
          </div>
        </div>
        
        <div className="mt-12 grid grid-cols-3 gap-1 pt-8">
          {[
            { label: 'Latency', val: '12ms' },
            { label: 'Uptime', val: '99.9%' },
            { label: 'Nodes', val: '1.2k' }
          ].map(stat => (
            <div key={stat.label} className="bento-card p-4 text-center">
              <p className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest mb-1">{stat.label}</p>
              <p className="text-lg font-mono font-bold text-blue-400">{stat.val}</p>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

// --- View Components ---

function DashboardView({ events, assignments, onAutoSchedule, onAdd }: { events: ScheduleEvent[], assignments: Assignment[], onAutoSchedule: () => void, onAdd: () => void }) {
  const today = new Date();
  const todaysEvents = events.filter(e => isSameDay(parseISO(e.startTime), today));
  const upcomingEvents = events.filter(e => parseISO(e.startTime) > today).slice(0, 5);
  const pendingAssignments = assignments.filter(a => a.status !== 'completed').sort((a, b) => a.priority === 'high' ? -1 : 1).slice(0, 4);

  const completedCount = assignments.filter(a => a.status === 'completed').length;
  const totalCount = assignments.length || 1;
  const progressPercent = Math.round((completedCount / totalCount) * 100);

  // Simple overlap detection
  const hasConflict = (event: ScheduleEvent) => {
    return events.some(other => {
      if (other.id === event.id) return false;
      const start1 = parseISO(event.startTime);
      const end1 = parseISO(event.endTime);
      const start2 = parseISO(other.startTime);
      const end2 = parseISO(other.endTime);
      return start1 < end2 && start2 < end1;
    });
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-8 relative z-10">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 auto-rows-max">
        
        {/* Status Hub - New Bento Item */}
        <div className="lg:col-span-4 lg:row-span-2">
          <section className="bento-card bg-zinc-900 border-zinc-800 p-8 h-full flex flex-col justify-center text-center relative group overflow-hidden">
             <div className="absolute top-0 left-0 w-full h-full bg-linear-to-b from-blue-500/5 to-transparent pointer-events-none" />
             <div className="relative mb-6">
                <svg className="w-32 h-32 mx-auto transform -rotate-90">
                  <circle cx="64" cy="64" r="58" stroke="currentColor" strokeWidth="8" fill="transparent" className="text-zinc-800" />
                  <motion.circle 
                    cx="64" cy="64" r="58" stroke="currentColor" strokeWidth="8" fill="transparent" 
                    strokeDasharray={364.4} 
                    initial={{ strokeDashoffset: 364.4 }}
                    animate={{ strokeDashoffset: 364.4 - (364.4 * progressPercent) / 100 }}
                    transition={{ duration: 1.5, ease: "easeOut" }}
                    className="text-blue-500 shadow-[0_0_15px_rgba(37,99,235,0.4)]" 
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                   <p className="text-3xl font-extrabold tracking-tighter">{progressPercent}%</p>
                   <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Complete</p>
                </div>
             </div>
             <h3 className="text-xl font-bold mb-2">Systems Operational</h3>
             <p className="text-sm text-zinc-500 mb-6">You've completed {completedCount} units this cycle. Keep sync active for optimal performance.</p>
             <Button onClick={onAutoSchedule} className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border-zinc-700 uppercase tracking-widest text-[10px] py-4">
                <Target className="w-3 h-3" /> System Checkup
             </Button>
          </section>
        </div>

        {/* Today's Agenda - Chronological View */}
        <div className="lg:col-span-8 lg:row-span-4">
          <section className="bento-card bg-zinc-900/40 backdrop-blur-sm border-zinc-800 flex flex-col h-full min-h-[500px]">
            <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-800 bg-zinc-900/50">
              <div className="flex items-center gap-3">
                 <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                 <h3 className="text-xs font-bold text-zinc-100 uppercase tracking-[0.2em]">Agenda_Stream</h3>
              </div>
              <div className="text-[10px] font-mono text-zinc-500 uppercase">{format(today, 'yyyy-MM-dd • EEEE')}</div>
            </div>
            
            <div className="p-6 flex-1 space-y-4">
              {todaysEvents.length > 0 ? todaysEvents.map((event, i) => (
                <div key={event.id} className="group relative flex items-center gap-6 p-4 rounded-xl border border-zinc-800 bg-zinc-900/20 hover:border-zinc-700 hover:bg-zinc-800/40 transition-all duration-300">
                  <div className="w-16 shrink-0 flex flex-col items-center">
                    <span className="text-xs font-mono font-bold text-blue-400">{format(parseISO(event.startTime), 'HH:mm')}</span>
                    <div className="w-px h-8 bg-zinc-800 my-1" />
                    <span className="text-[9px] font-mono text-zinc-600">{format(parseISO(event.endTime), 'HH:mm')}</span>
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-bold text-zinc-100 truncate group-hover:text-blue-200 transition-colors">{event.title}</h4>
                      {hasConflict(event) && (
                        <span className="flex items-center gap-1 text-[8px] bg-red-500/10 text-red-500 px-2 py-0.5 rounded-full font-bold uppercase tracking-widest border border-red-500/20">
                          Conflict
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                       <span className={cn(
                          "text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border",
                          event.type === 'class' ? 'border-blue-500/20 text-blue-400 bg-blue-500/5' : 
                          event.type === 'exam' ? 'border-red-500/20 text-red-400 bg-red-500/5' : 
                          'border-zinc-700 text-zinc-500'
                       )}>
                          {event.type}
                       </span>
                       {event.location && <span className="text-[10px] text-zinc-600 font-medium truncate italic">@ {event.location}</span>}
                    </div>
                  </div>

                  <button className="opacity-0 group-hover:opacity-100 p-2 text-zinc-500 hover:text-zinc-100 transition-all">
                    <MoreHorizontal className="w-5 h-5" />
                  </button>
                </div>
              )) : (
                <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-center opacity-30 border-2 border-dashed border-zinc-800 rounded-3xl p-12">
                  <CalendarDays className="w-16 h-16 mb-4 text-zinc-700" />
                  <p className="text-sm font-mono tracking-widest mb-2">MANIFEST_CLEAR</p>
                  <p className="text-xs text-zinc-600 max-w-[200px]">No operations scheduled for today. Use AI link to initialize.</p>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Side Actions & Metrics */}
        <div className="lg:col-span-4 lg:row-span-4 flex flex-col gap-6">
           <section className="bento-card p-6 bg-linear-to-br from-blue-600 to-indigo-700 text-white relative overflow-hidden group shadow-[0_20px_40px_rgba(37,99,235,0.2)]">
            <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full blur-3xl -mr-16 -mt-16 transition-transform duration-1000 group-hover:translate-x-10" />
            <div className="relative z-10 flex flex-col h-full">
              <div className="flex items-center gap-2 mb-4">
                 <div className="w-6 h-6 bg-white/20 rounded-lg flex items-center justify-center backdrop-blur-md">
                   <Clock className="w-3 h-3" />
                 </div>
                 <span className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-80">AI Link</span>
              </div>
              <p className="text-lg font-extrabold leading-tight tracking-tight mb-8">
                Request a neural-sync to optimize next 48h.
              </p>
              <Button 
                variant="secondary" 
                onClick={onAutoSchedule}
                className="w-full bg-white text-blue-600 border-none py-4 shadow-xl hover:shadow-2xl transition-all font-bold tracking-widest text-[10px]"
              >
                SYNC SCHEDULE
              </Button>
            </div>
          </section>

          <section className="bento-card p-6 bg-zinc-900 border-zinc-800 flex-1">
             <div className="flex items-center justify-between mb-8">
                <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Task_Register</h3>
                <button 
                  onClick={onAdd}
                  className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400 border border-zinc-700 hover:bg-zinc-700 hover:text-white transition-colors"
                >
                  <Plus className="w-4 h-4" />
                </button>
             </div>
             <div className="space-y-4">
              {pendingAssignments.length > 0 ? pendingAssignments.map(a => (
                <div key={a.id} className="group flex flex-col p-4 rounded-xl bg-zinc-950/50 border border-zinc-800 hover:border-blue-500/30 transition-all cursor-pointer">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[9px] font-mono font-bold text-zinc-600 uppercase tracking-widest">{a.subject}</span>
                    <span className={cn(
                      "text-[8px] font-bold px-2 py-0.5 rounded-full uppercase tracking-tighter border",
                      a.priority === 'high' ? 'border-red-500/30 text-red-400 bg-red-500/5' : 'border-emerald-500/30 text-emerald-400 bg-emerald-500/5'
                    )}>{a.priority}</span>
                  </div>
                  <h4 className="text-xs font-bold text-zinc-200 group-hover:text-blue-300 transition-colors mb-4">{a.title}</h4>
                  <div className="flex items-center justify-between">
                     <div className="flex items-center gap-1.5 text-red-500/60">
                        <Clock className="w-3 h-3" />
                        <span className="text-[9px] font-mono font-bold">{format(parseISO(a.dueDate), 'MM-dd')}</span>
                     </div>
                     <ChevronRight className="w-3 h-3 text-zinc-700 group-hover:text-blue-500 group-hover:translate-x-1" />
                  </div>
                </div>
              )) : (
                <div className="text-center py-12 opacity-20 bg-zinc-950 border border-zinc-800 rounded-2xl">
                  <CheckCircle2 className="w-8 h-8 mx-auto mb-2" />
                  <p className="text-[10px] font-mono uppercase tracking-widest">Register_Empty</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </motion.div>
  );
}

function StatItem({ label, value, icon: Icon, color }: { label: string, value: string, icon: any, color: string }) {
  return (
    <div className="flex items-center gap-4">
      <div className={cn("w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center", color)}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <p className="text-lg font-bold">{value}</p>
      </div>
    </div>
  );
}

function CalendarView({ events, selectedDate, setSelectedDate }: { events: ScheduleEvent[], selectedDate: Date, setSelectedDate: (d: Date) => void }) {
  const [viewType, setViewType] = useState<'month' | 'week' | 'day'>('month');

  const monthStart = startOfMonth(selectedDate);
  const monthEnd = endOfMonth(monthStart);
  const startDate = startOfWeek(monthStart);
  const endDate = endOfWeek(monthEnd);

  const weekStart = startOfWeek(selectedDate);
  const weekDays = eachDayOfInterval({ start: weekStart, end: endOfWeek(selectedDate) });

  const hours = Array.from({ length: 24 }, (_, i) => i);

  const handlePrev = () => {
    if (viewType === 'month') setSelectedDate(addMonths(selectedDate, -1));
    else if (viewType === 'week') setSelectedDate(addDays(selectedDate, -7));
    else setSelectedDate(addDays(selectedDate, -1));
  };

  const handleNext = () => {
    if (viewType === 'month') setSelectedDate(addMonths(selectedDate, 1));
    else if (viewType === 'week') setSelectedDate(addDays(selectedDate, 7));
    else setSelectedDate(addDays(selectedDate, 1));
  };

  const calendarDays = eachDayOfInterval({ start: startDate, end: endDate });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 relative z-10 w-full max-w-6xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-2">
        <div>
          <h2 className="text-3xl font-extrabold tracking-tighter uppercase mb-1">
            {format(selectedDate, viewType === 'month' ? 'MMMM yyyy' : viewType === 'week' ? "'Week of' MMM dd" : 'MMMM dd, yyyy')}
          </h2>
          <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Temporal_Matrix_Active</p>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
            {[
              { id: 'month', icon: Layers, label: 'Month' },
              { id: 'week', icon: Columns, label: 'Week' },
              { id: 'day', icon: Rows, label: 'Day' }
            ].map((v) => (
              <button
                key={v.id}
                onClick={() => setViewType(v.id as any)}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all",
                  viewType === v.id ? "bg-blue-600 text-white shadow-lg" : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                <v.icon className="w-3 h-3" />
                <span className="hidden sm:inline">{v.label}</span>
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={handlePrev} className="border-zinc-800 hover:bg-zinc-800 p-2">
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button variant="secondary" onClick={() => setSelectedDate(new Date())} className="border-zinc-800 text-[10px] font-bold uppercase tracking-widest h-10">
              Today
            </Button>
            <Button variant="secondary" onClick={handleNext} className="border-zinc-800 hover:bg-zinc-800 p-2">
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="bento-card border-zinc-800 bg-zinc-900/40 backdrop-blur-sm overflow-hidden min-h-[600px] flex flex-col">
        {viewType === 'month' && (
          <>
            <div className="grid grid-cols-7 border-b border-zinc-800 bg-zinc-900/60">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                <div key={day} className="py-4 text-center text-[10px] font-bold text-zinc-500 uppercase tracking-[0.2em] border-r border-zinc-800 last:border-0">
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 flex-1">
              {calendarDays.map((day, i) => {
                const dayEvents = events.filter(e => isSameDay(parseISO(e.startTime), day));
                const isCurrentMonth = isSameMonth(day, monthStart);
                const isTodayDate = isToday(day);

                return (
                  <div 
                    key={day.toString()} 
                    onClick={() => viewType === 'month' && setSelectedDate(day)}
                    className={cn(
                      "min-h-[140px] p-2 border-r border-b border-zinc-800 transition-all duration-300 group",
                      !isCurrentMonth ? "bg-zinc-950/30 opacity-40" : "hover:bg-zinc-800/40",
                      isTodayDate && "bg-blue-500/[0.03]"
                    )}
                  >
                    <div className="flex justify-between items-start mb-2 p-1">
                      <span className={cn(
                        "w-8 h-8 flex items-center justify-center rounded-xl text-xs font-mono font-bold transition-transform group-hover:scale-110",
                        isTodayDate ? "bg-blue-600 text-white shadow-lg" : "text-zinc-400 group-hover:text-zinc-100"
                      )}>
                        {format(day, 'd')}
                      </span>
                    </div>
                    <div className="space-y-1 px-1">
                      {dayEvents.slice(0, 4).map(event => (
                        <div 
                          key={event.id} 
                          className={cn(
                            "px-2 py-1 rounded text-[9px] font-bold truncate border flex items-center gap-1.5",
                            event.type === 'class' ? 'bg-blue-500/10 border-blue-500/20 text-blue-400' :
                            event.type === 'exam' ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                            'bg-zinc-800 border-zinc-700 text-zinc-400'
                          )}
                        >
                          <div className={cn("w-1 h-1 rounded-full", 
                            event.type === 'class' ? 'bg-blue-500' : 
                            event.type === 'exam' ? 'bg-red-500' : 
                            'bg-zinc-500'
                          )} />
                          {event.title}
                        </div>
                      ))}
                      {dayEvents.length > 4 && (
                        <p className="text-[9px] text-zinc-600 font-mono pl-1">
                          + {dayEvents.length - 4} more
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {viewType === 'week' && (
          <div className="flex flex-col flex-1">
            <div className="grid grid-cols-[100px_repeat(7,1fr)] border-b border-zinc-800 bg-zinc-900/60">
              <div className="p-4"></div>
              {weekDays.map(day => (
                <div key={day.toString()} className="py-4 text-center border-l border-zinc-800">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{format(day, 'EEE')}</p>
                  <p className={cn("text-lg font-extrabold mt-1", isToday(day) ? "text-blue-500" : "text-zinc-200")}>{format(day, 'dd')}</p>
                </div>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto max-h-[700px]">
              {hours.map(hour => (
                <div key={hour} className="grid grid-cols-[100px_repeat(7,1fr)] border-b border-zinc-800/50 group">
                  <div className="p-4 text-[10px] font-mono text-zinc-600 text-right pr-6 self-start group-hover:text-zinc-400">
                    {format(new Date().setHours(hour, 0), 'HH:mm')}
                  </div>
                  {weekDays.map(day => {
                    const hourEvents = events.filter(e => {
                      const start = parseISO(e.startTime);
                      return isSameDay(start, day) && start.getHours() === hour;
                    });

                    return (
                      <div key={day.toString()} className="border-l border-zinc-800/50 min-h-[60px] p-1 relative">
                        {hourEvents.map(event => (
                          <div 
                            key={event.id}
                            className={cn(
                              "mb-1 px-2 py-1 rounded text-[9px] font-bold border truncate flex items-center gap-1.5",
                              event.type === 'class' ? 'border-blue-500/20 text-blue-400 bg-blue-500/5' : 
                              event.type === 'exam' ? 'border-red-500/20 text-red-400 bg-red-500/5' : 
                              'border-zinc-700 text-zinc-400 bg-zinc-800'
                            )}
                          >
                            <div className={cn("w-1 h-1 rounded-full", 
                              event.type === 'class' ? 'bg-blue-500' : 
                              event.type === 'exam' ? 'bg-red-500' : 
                              'bg-zinc-500'
                            )} />
                            {event.title}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {viewType === 'day' && (
          <div className="flex flex-col flex-1">
             <div className="p-8 border-b border-zinc-800 bg-zinc-900/60 flex items-center gap-6">
                <div className="w-20 h-20 bg-blue-600 rounded-3xl flex flex-col items-center justify-center text-white shadow-2xl">
                  <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">{format(selectedDate, 'MMM')}</span>
                  <span className="text-3xl font-extrabold">{format(selectedDate, 'dd')}</span>
                </div>
                <div>
                   <h3 className="text-2xl font-extrabold uppercase tracking-tight">{format(selectedDate, 'EEEE')}</h3>
                   <div className="flex items-center gap-2 mt-2">
                      <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">{events.filter(e => isSameDay(parseISO(e.startTime), selectedDate)).length} Operations Scheduled</p>
                   </div>
                </div>
             </div>
             <div className="flex-1 overflow-y-auto p-4 max-h-[700px]">
                {hours.map(hour => {
                   const hourEvents = events.filter(e => {
                     const start = parseISO(e.startTime);
                     return isSameDay(start, selectedDate) && start.getHours() === hour;
                   });

                   return (
                     <div key={hour} className="flex gap-6 group hover:bg-zinc-800/20 transition-colors rounded-xl p-2">
                        <div className="w-20 pt-2 text-[10px] font-mono text-zinc-600 text-right group-hover:text-zinc-400">
                          {format(new Date().setHours(hour, 0), 'HH:mm')}
                        </div>
                        <div className="flex-1 border-l border-zinc-800 pl-6 py-2 space-y-3">
                           {hourEvents.length > 0 ? hourEvents.map(event => (
                              <div key={event.id} className="flex items-center gap-4 p-4 bg-zinc-950 border border-zinc-800 rounded-2xl group/item hover:border-blue-500/30 transition-all">
                                 <div className={cn(
                                   "w-2 h-12 rounded-full",
                                   event.type === 'class' ? 'bg-blue-500' : event.type === 'exam' ? 'bg-red-500' : 'bg-zinc-700'
                                 )} />
                                 <div className="flex-1">
                                    <p className="text-xs font-bold uppercase text-zinc-500 tracking-widest mb-1">{event.type}</p>
                                    <h4 className="font-extrabold text-zinc-100">{event.title}</h4>
                                    <p className="text-[10px] font-mono text-zinc-400 mt-1">{format(parseISO(event.startTime), 'HH:mm')} — {format(parseISO(event.endTime), 'HH:mm')}</p>
                                 </div>
                                 {event.location && (
                                   <div className="px-4 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-[10px] font-bold text-zinc-500">
                                      @{event.location}
                                   </div>
                                 )}
                              </div>
                           )) : (
                             <div className="h-12 border-b border-zinc-800/30 flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                                <span className="text-[10px] font-mono text-zinc-800">SLOT_AVAILABLE</span>
                             </div>
                           )}
                        </div>
                     </div>
                   );
                })}
             </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function AssignmentsView({ assignments, toggleStatus }: { assignments: Assignment[], toggleStatus: (a: Assignment) => void }) {
  const [filter, setFilter] = useState<AssignmentStatus | 'all'>('all');
  const filtered = assignments.filter(a => filter === 'all' || a.status === filter);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-8 relative z-10">
      <div className="flex items-center justify-between">
        <h3 className="text-3xl font-extrabold tracking-tighter uppercase">Task <span className="text-blue-500">Registry</span></h3>
        <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
          {['all', 'todo', 'in_progress', 'completed'].map(s => (
            <button 
              key={s} 
              onClick={() => setFilter(s as any)}
              className={cn(
                "px-4 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all",
                filter === s ? "bg-zinc-800 text-blue-400 shadow-sm" : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filtered.map(a => (
          <motion.div layout key={a.id}>
            <div className="bento-card bg-zinc-900 border-zinc-800 hover:shadow-[0_0_30px_rgba(37,99,235,0.05)] transition-all group h-full flex flex-col">
              <div className="p-6 flex-1 flex flex-col">
                <div className="flex items-center justify-between mb-4">
                  <span className="bg-zinc-800 text-zinc-500 text-[9px] px-2.5 py-1 rounded-md font-mono font-bold uppercase tracking-widest whitespace-nowrap overflow-hidden text-ellipsis mr-2">{a.subject}</span>
                  <div className={cn(
                    "status-dot shadow-[0_0_8px_currentColor]",
                    a.status === 'completed' ? 'text-emerald-500 bg-emerald-500' : a.status === 'in_progress' ? 'text-amber-500 bg-amber-500' : 'text-zinc-700 bg-zinc-700'
                  )} />
                </div>
                <h4 className={cn("text-lg font-bold mb-3 group-hover:text-blue-400 transition-colors leading-tight", a.status === 'completed' && "line-through opacity-40 text-zinc-500")}>
                  {a.title}
                </h4>
                <p className="text-xs text-zinc-500 mb-6 flex-1 line-clamp-3 leading-relaxed">
                  {a.description || 'No system documentation available for this task.'}
                </p>
                
                <div className="flex items-center justify-between pt-5 border-t border-zinc-800 mt-auto">
                  <div className="flex flex-col">
                    <span className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest mb-1">Deadline</span>
                    <div className="flex items-center gap-2 text-[10px] font-mono font-bold text-red-400/80">
                      <Clock className="w-3 h-3" />
                      {format(parseISO(a.dueDate), 'yyyy-MM-dd')}
                    </div>
                  </div>
                  <button 
                    onClick={() => toggleStatus(a)}
                    className={cn(
                      "w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300",
                      a.status === 'completed' 
                        ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" 
                        : "bg-zinc-800 text-zinc-500 hover:bg-blue-600 hover:text-white hover:shadow-[0_0_15px_rgba(37,99,235,0.3)]"
                    )}
                  >
                    <CheckCircle2 className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
      
      {filtered.length === 0 && (
        <div className="text-center py-20 bento-card bg-zinc-900/20 border-2 border-dashed border-zinc-800">
          <BookOpen className="w-12 h-12 text-zinc-800 mx-auto mb-4" />
          <p className="text-sm font-mono font-bold text-zinc-600 uppercase tracking-[0.2em]">EMPTY_REGISTRY</p>
          <Button variant="ghost" className="mt-4 text-[10px] font-bold uppercase tracking-widest" onClick={() => setFilter('all')}>List All Units</Button>
        </div>
      )}
    </motion.div>
  );
}

function ChatView({ messages, input, setInput, onSend, isLoading }: { messages: ChatMessage[], input: string, setInput: (s: string) => void, onSend: (e?: React.FormEvent) => void, isLoading: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full flex flex-col max-w-4xl mx-auto bento-card bg-zinc-900/60 backdrop-blur-xl border-zinc-800 shadow-2xl relative z-10">
      {/* Chat Header */}
      <div className="p-6 bg-zinc-900 border-b border-zinc-800 flex items-center gap-6">
        <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-[0_0_20px_rgba(37,99,235,0.3)]">
          <MessageSquare className="w-6 h-6" />
        </div>
        <div className="flex-1">
          <h3 className="font-extrabold text-lg uppercase tracking-tight">AI Assistant <span className="text-blue-500 text-xs font-mono ml-2 border border-blue-500/30 px-1.5 py-0.5 rounded tracking-widest">v2.1</span></h3>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="status-dot bg-emerald-500 animate-pulse"></span>
            <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest leading-none">Quantum Neural Link Active</p>
          </div>
        </div>
        <div className="flex space-x-1">
           <div className="w-2 h-2 rounded-full bg-zinc-800" />
           <div className="w-2 h-2 rounded-full bg-zinc-800" />
           <div className="w-2 h-2 rounded-full bg-zinc-800" />
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-8 space-y-8 bg-zinc-950/20">
        {messages.length === 0 && (
          <div className="text-center py-10 space-y-6">
            <div className="w-16 h-16 bg-zinc-900 border border-zinc-800 text-blue-500 rounded-3xl flex items-center justify-center mx-auto shadow-inner">
              <Plus className="w-8 h-8" />
            </div>
            <p className="text-zinc-500 text-xs font-mono uppercase tracking-[0.2em]">AWAITING_INPUT_COMMANDS</p>
            <div className="flex flex-wrap justify-center gap-3 max-w-md mx-auto">
              {["Schedule an exam on May 10th", "Add Physics lab on Thursdays 2pm", "Plan my study schedule"].map(t => (
                <button key={t} onClick={() => setInput(t)} className="text-[10px] font-bold uppercase tracking-widest bg-zinc-900 border border-zinc-800 px-4 py-2.5 rounded-xl hover:border-blue-500 hover:text-blue-400 transition-all shadow-sm text-zinc-400">
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}
        
        {messages.map((m, i) => (
          <motion.div 
            key={m.id || i}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn(
              "flex items-start gap-5 max-w-[90%]",
              m.role === 'user' ? "ml-auto flex-row-reverse" : ""
            )}
          >
            <div className={cn(
              "w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border transition-transform duration-300 hover:scale-110",
              m.role === 'user' ? "bg-blue-600 border-blue-400/20 text-white shadow-lg shadow-blue-500/20" : "bg-zinc-800 border-zinc-700 text-blue-400"
            )}>
              {m.role === 'user' ? <UserIcon className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
            </div>
            <div className={cn(
              "p-5 rounded-2xl text-sm leading-relaxed",
              m.role === 'user' ? "bg-blue-600 text-white rounded-tr-none shadow-xl shadow-blue-500/10" : "bg-zinc-900/80 border border-zinc-800 text-zinc-200 rounded-tl-none backdrop-blur-sm"
            )}>
              <div className="markdown-body">
                <ReactMarkdown>{m.text}</ReactMarkdown>
              </div>
            </div>
          </motion.div>
        ))}
        {isLoading && (
          <div className="flex items-start gap-5 max-w-[80%]">
            <div className="w-10 h-10 rounded-xl bg-zinc-800 border border-zinc-700 text-blue-400 flex items-center justify-center shadow-sm">
              <Clock className="animate-spin w-5 h-5" />
            </div>
            <div className="p-5 bg-zinc-900/80 border border-zinc-800 rounded-2xl rounded-tl-none shadow-sm flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" />
            </div>
          </div>
        )}
      </div>

      <form onSubmit={onSend} className="p-6 bg-zinc-900 border-t border-zinc-800 flex gap-4 items-center">
        <div className="flex-1 relative">
          <input 
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Execute natural language command..." 
            className="w-full px-6 py-4 bg-zinc-950 border border-zinc-800 rounded-2xl focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all font-mono text-sm text-zinc-300 placeholder:text-zinc-600"
          />
          <div className="absolute right-4 top-1/2 -translate-y-1/2 flex gap-1">
             <div className="w-1 h-3 bg-blue-500/30 rounded-full" />
             <div className="w-1 h-5 bg-blue-500/50 rounded-full" />
             <div className="w-1 h-3 bg-blue-500/30 rounded-full" />
          </div>
        </div>
        <button 
          disabled={isLoading || !input.trim()}
          type="submit"
          className="w-14 h-14 bg-blue-600 text-white rounded-2xl flex items-center justify-center hover:bg-blue-700 transition-all active:scale-90 disabled:opacity-50 shadow-lg shadow-blue-500/20 border border-blue-400/20"
        >
          <Send className="w-6 h-6" />
        </button>
      </form>
    </motion.div>
  );
}

function AddEntryModal({ isOpen, onClose, user, events, onConflictDetected }: { 
  isOpen: boolean, 
  onClose: () => void, 
  user: User | null, 
  events: ScheduleEvent[],
  onConflictDetected: (conflict: { newEvent: any, existingEvent: ScheduleEvent }) => void 
}) {
  const [activeTab, setActiveTab] = useState<'event' | 'assignment'>('event');
  const [formData, setFormData] = useState({
    title: '',
    type: 'class',
    startTime: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
    endTime: format(addHours(new Date(), 1), "yyyy-MM-dd'T'HH:mm"),
    location: '',
    description: '',
    priority: 'medium',
    subject: '',
    dueDate: format(addDays(new Date(), 7), "yyyy-MM-dd"),
    recurrenceFreq: 'none',
    daysOfWeek: [] as number[],
    recurrenceUntil: format(addMonths(new Date(), 3), "yyyy-MM-dd")
  });

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    try {
      if (activeTab === 'event') {
        const newEvent = {
          title: formData.title,
          type: formData.type,
          startTime: new Date(formData.startTime).toISOString(),
          endTime: new Date(formData.endTime).toISOString(),
          location: formData.location || undefined,
          description: formData.description || undefined,
          recurrence: formData.recurrenceFreq !== 'none' ? {
            frequency: formData.recurrenceFreq as any,
            daysOfWeek: formData.recurrenceFreq === 'weekly' ? formData.daysOfWeek : undefined,
            until: new Date(formData.recurrenceUntil).toISOString()
          } : undefined
        };

        // Check conflict
        const conflict = events.find(other => {
          const s1 = parseISO(newEvent.startTime);
          const e1 = parseISO(newEvent.endTime);
          const s2 = parseISO(other.startTime);
          const e2 = parseISO(other.endTime);
          return s1 < e2 && s2 < e1;
        });

        if (conflict) {
          onConflictDetected({ newEvent, existingEvent: conflict });
        } else {
          try {
            // Scrub undefined properties
            const cleanEvent = Object.fromEntries(
              Object.entries(newEvent).filter(([_, v]) => v !== undefined)
            );
            await addDoc(collection(db, 'users', user.uid, 'events'), cleanEvent);
            toast.success(`Created ${formData.type}: ${formData.title}`);
          } catch (error) {
            handleFirestoreError(error, OperationType.CREATE, `users/${user.uid}/events`);
          }
        }
      } else {
        try {
          await addDoc(collection(db, 'users', user.uid, 'assignments'), {
            title: formData.title,
            subject: formData.subject || 'other',
            dueDate: new Date(formData.dueDate).toISOString(),
            priority: formData.priority,
            status: 'todo'
          });
          toast.success(`Registered assignment: ${formData.title}`);
        } catch (error) {
          handleFirestoreError(error, OperationType.CREATE, `users/${user.uid}/assignments`);
        }
      }
      onClose();
    } catch (err) {
      console.error(err);
      if (err instanceof Error && err.message.startsWith('{')) {
        const info = JSON.parse(err.message);
        toast.error(`${info.error} (${info.operationType} on ${info.path})`);
      } else {
        toast.error("Process failed");
      }
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-zinc-950/80 backdrop-blur-sm"
    >
      <motion.div 
        initial={{ scale: 0.9, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        className="bento-card bg-zinc-900 border-zinc-800 p-8 max-w-lg w-full shadow-2xl relative overflow-hidden"
      >
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-xl font-extrabold uppercase tracking-tight">Manual Entry</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex gap-2 p-1 bg-zinc-950 border border-zinc-800 rounded-xl mb-8">
          <button 
            onClick={() => setActiveTab('event')}
            className={cn(
              "flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-all",
              activeTab === 'event' ? "bg-zinc-800 text-white shadow-lg" : "text-zinc-500"
            )}
          >
            Event / Class
          </button>
          <button 
            onClick={() => setActiveTab('assignment')}
            className={cn(
              "flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-all",
              activeTab === 'assignment' ? "bg-zinc-800 text-white shadow-lg" : "text-zinc-500"
            )}
          >
            Assignment
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-4 max-h-[60vh] overflow-y-auto px-1">
            <div>
              <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest mb-1.5 block">Title</label>
              <input 
                required
                value={formData.title}
                onChange={e => setFormData({...formData, title: e.target.value})}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 focus:outline-none focus:border-blue-500/50"
                placeholder="e.g. Computer Science 101"
              />
            </div>

            {activeTab === 'event' ? (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest mb-1.5 block">Type</label>
                    <select 
                      value={formData.type}
                      onChange={e => setFormData({...formData, type: e.target.value})}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 focus:outline-none"
                    >
                      <option value="class">Class</option>
                      <option value="exam">Exam</option>
                      <option value="study">Study</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest mb-1.5 block">Recurrence</label>
                    <select 
                      value={formData.recurrenceFreq}
                      onChange={e => setFormData({...formData, recurrenceFreq: e.target.value})}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 focus:outline-none"
                    >
                      <option value="none">One-time</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest mb-1.5 block">Start</label>
                    <input 
                      type="datetime-local"
                      required
                      value={formData.startTime}
                      onChange={e => setFormData({...formData, startTime: e.target.value})}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest mb-1.5 block">End</label>
                    <input 
                      type="datetime-local"
                      required
                      value={formData.endTime}
                      onChange={e => setFormData({...formData, endTime: e.target.value})}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 focus:outline-none"
                    />
                  </div>
                </div>

                {formData.recurrenceFreq !== 'none' && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-4">
                    {formData.recurrenceFreq === 'weekly' && (
                      <div>
                        <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest mb-2 block">Repeat On</label>
                        <div className="flex justify-between gap-1">
                          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => {
                                const newDays = formData.daysOfWeek.includes(i)
                                  ? formData.daysOfWeek.filter(d => d !== i)
                                  : [...formData.daysOfWeek, i];
                                setFormData({ ...formData, daysOfWeek: newDays });
                              }}
                              className={cn(
                                "w-9 h-9 rounded-lg text-[10px] font-bold transition-all border",
                                formData.daysOfWeek.includes(i) 
                                  ? "bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-500/20" 
                                  : "bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-700"
                              )}
                            >
                              {day}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div>
                      <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest mb-1.5 block">Repeat Until</label>
                      <input 
                        type="date"
                        value={formData.recurrenceUntil}
                        onChange={e => setFormData({...formData, recurrenceUntil: e.target.value})}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 focus:outline-none"
                      />
                    </div>
                  </motion.div>
                )}
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest mb-1.5 block">Subject</label>
                    <select 
                      required
                      value={formData.subject}
                      onChange={e => setFormData({...formData, subject: e.target.value})}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 focus:outline-none"
                    >
                      <option value="">Select Subject</option>
                      <option value="python">Python</option>
                      <option value="java">Java</option>
                      <option value="os">OS</option>
                      <option value="se">SE</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest mb-1.5 block">Priority</label>
                    <select 
                      value={formData.priority}
                      onChange={e => setFormData({...formData, priority: e.target.value})}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 focus:outline-none"
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest mb-1.5 block">Due Date</label>
                  <input 
                    type="date"
                    required
                    value={formData.dueDate}
                    onChange={e => setFormData({...formData, dueDate: e.target.value})}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 focus:outline-none"
                  />
                </div>
              </>
            )}
          </div>

          <Button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 py-4 uppercase tracking-[0.2em] text-[10px] font-extrabold mt-4 shadow-xl shadow-blue-500/10">
            Authorize Entry
          </Button>
        </form>
      </motion.div>
    </motion.div>
  );
}
