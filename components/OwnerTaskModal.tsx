import React from 'react';
import { CheckCircle, Clock, X } from 'lucide-react';
import { PADEntry } from '../types';

interface OwnerTaskModalProps {
  isOpen: boolean;
  ownerName: string;
  tasks: PADEntry[];
  onClose: () => void;
  onTaskClick: (task: PADEntry) => void;
}

const OwnerTaskModal: React.FC<OwnerTaskModalProps> = ({
  isOpen,
  ownerName,
  tasks,
  onClose,
  onTaskClick
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-6 animate-in fade-in duration-200">
      <div className="bg-white rounded-[2rem] w-full max-w-2xl shadow-2xl animate-in zoom-in-95 flex flex-col max-h-[90vh]">
        <div className="p-6 border-b flex justify-between items-center">
          <h3 className="text-lg font-black text-slate-800 truncate">{ownerName}</h3>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full">
            <X size={20}/>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {tasks.length === 0 ? (
            <div className="text-center py-10 text-slate-400 text-sm italic font-medium">暂无任务</div>
          ) : (
            <div className="flex flex-col gap-3">
              {tasks.map(task => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onTaskClick(task)}
                  className="w-full text-left bg-white p-4 rounded-2xl border shadow-sm text-sm font-bold text-slate-700 transition-all hover:border-brand-300 hover:bg-brand-50/30"
                >
                  <div className="flex items-start gap-2">
                    {task.status === 'completed'
                      ? <CheckCircle size={16} className="text-emerald-500 shrink-0 mt-0.5"/>
                      : <Clock size={16} className="text-amber-500 shrink-0 mt-0.5"/>}
                    <span className="min-w-0 flex-1 break-words">{task.title}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OwnerTaskModal;
