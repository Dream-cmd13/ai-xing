import React, { useState, useEffect } from 'react';
import { PADEntry, User, Department, AISettings } from '../types';
import { X, AlertCircle, Wand2, Loader2, Sparkles, CheckCircle, Trash2 } from 'lucide-react';
import { checkPADQuality } from '../services/gemini';

interface TaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  data: Partial<PADEntry>;
  setData: (data: Partial<PADEntry>) => void;
  onSave: (status: string, keepOpen?: boolean) => void;
  onDelete?: () => void;
  users: User[];
  departments?: Department[];
  groupedAvailableKRs: { label: string, options: { id: string, name: string }[] }[];
  mode: 'create' | 'edit';
  readOnly?: boolean;
  periodWeeks?: { id: string, label: string }[];
  aiSettings?: AISettings;
}

const TaskModal: React.FC<TaskModalProps> = ({
  isOpen,
  onClose,
  data,
  setData,
  onSave,
  onDelete,
  users,
  departments = [],
  groupedAvailableKRs,
  mode,
  readOnly = false,
  periodWeeks = [],
  aiSettings
}) => {
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setAiResult(null);
    }
  }, [isOpen]);

  const runAiCheck = async () => {
    if (!data.title) {
      setError('请先输入任务标题再进行 AI 检查');
      return;
    }
    setChecking(true);
    setAiResult(null);
    try {
      const result = await checkPADQuality(aiSettings, data.title, data.action || '', data.deliverable || '');
      setAiResult(result);
    } catch (e) {
      setError('AI 检查失败');
    } finally {
      setChecking(false);
    }
  };

  if (!isOpen) return null;
  const isEditing = mode === 'edit';

  const handleSave = (status: string, keepOpen?: boolean) => {
    // Validation
    if (!data.title || data.title.trim() === '') {
      setError('任务标题不能为空');
      return;
    }
    if (!data.ownerId) {
      setError('请选择负责人');
      return;
    }
    if (!data.startDate) {
      setError('请选择开始时间');
      return;
    }
    if (!data.dueDate) {
      setError('请选择截止时间');
      return;
    }

    if (data.startDate && data.dueDate && data.startDate > data.dueDate) {
      setError('截止时间不得早于开始时间');
      return;
    }

    setError(null);
    onSave(status, keepOpen);
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-6 animate-in fade-in duration-200">
      <div className="bg-white rounded-[2rem] w-full max-w-2xl shadow-2xl animate-in zoom-in-95 flex flex-col max-h-[90vh]">
        <div className="p-6 border-b flex justify-between items-center">
          <h3 className="text-lg font-black text-slate-800">
            {isEditing ? '编辑任务' : '创建任务'}
          </h3>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full"><X size={20}/></button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
          {error && (
            <div className="bg-red-50 border border-red-100 p-4 rounded-2xl flex items-center gap-3 text-red-600 animate-in slide-in-from-top-2">
              <AlertCircle size={18} />
              <span className="text-sm font-bold">{error}</span>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex justify-between items-center mb-1">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">任务标题</label>
              <button 
                onClick={runAiCheck}
                disabled={checking || readOnly}
                className="flex items-center gap-1 text-[10px] font-black text-brand-600 hover:text-brand-700 disabled:opacity-50"
              >
                {checking ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                AI 质量检查
              </button>
            </div>
            <textarea 
              placeholder="输入任务标题，如：本周完成财务分析报表&#10;输入多行可以同时创建多条任务" 
              className="w-full h-24 p-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold outline-none focus:border-brand-500 resize-none disabled:opacity-50"
              value={data.title || ''}
              disabled={readOnly}
              onChange={e => {
                setData({ ...data, title: e.target.value });
                if (error) setError(null);
              }}
            />
          </div>

          {aiResult && (
            <div className="p-4 bg-brand-50 rounded-2xl border border-brand-100 text-[11px] font-bold text-slate-700 relative shadow-inner animate-in fade-in slide-in-from-top-2">
              <div className="flex items-center gap-2 mb-2 text-brand-700">
                <Sparkles size={14} />
                <span className="uppercase tracking-widest text-[9px] font-black">AI 诊断建议</span>
              </div>
              <div className="leading-relaxed whitespace-pre-wrap">{aiResult}</div>
              <button onClick={() => setAiResult(null)} className="absolute top-3 right-4 p-1 text-slate-300 hover:text-brand-600">
                <CheckCircle size={14} />
              </button>
            </div>
          )}

          <div className="flex gap-4">
            <div className="flex-1 space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">状态</label>
              <select 
                className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none disabled:opacity-50"
                value={data.status || 'draft'}
                disabled={readOnly}
                onChange={e => setData({ ...data, status: e.target.value as any })}
              >
                <option value="draft">草稿</option>
                <option value="submitted">已提交</option>
                <option value="in-progress">处理中</option>
                <option value="paused">暂停</option>
                <option value="terminated">终止</option>
                <option value="completed">已完成</option>
              </select>
            </div>
            <div className="flex-1 space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">优先级</label>
              <div className="flex bg-slate-50 p-1 rounded-xl border border-slate-200">
                {['low', 'medium', 'high'].map(p => (
                  <button 
                    key={p}
                    disabled={readOnly}
                    onClick={() => setData({ ...data, priority: p as any })}
                    className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase transition-all disabled:opacity-50 ${data.priority === p ? 'bg-white shadow-sm text-brand-600' : 'text-slate-400'}`}
                  >
                    {p === 'high' ? '高' : p === 'medium' ? '中' : '低'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-4">
            <div className="flex-1 space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">开始时间</label>
              <input 
                type="date" 
                disabled={readOnly}
                className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none disabled:opacity-50"
                value={data.startDate ? new Date(data.startDate).toISOString().split('T')[0] : ''}
                onChange={e => {
                  setData({ ...data, startDate: new Date(e.target.value).getTime() });
                  if (error) setError(null);
                }}
              />
            </div>
            <div className="flex-1 space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">截止时间</label>
              <input 
                type="date" 
                disabled={readOnly}
                className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none disabled:opacity-50"
                value={data.dueDate ? new Date(data.dueDate).toISOString().split('T')[0] : ''}
                onChange={e => {
                  setData({ ...data, dueDate: new Date(e.target.value).getTime() });
                  if (error) setError(null);
                }}
              />
            </div>
          </div>

          <div className="flex gap-4">
            <div className="flex-1 space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">参与人</label>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl min-h-[42px] flex flex-wrap gap-2">
                {(data.participantIds || []).map(uid => {
                  const u = users.find(user => user.id === uid);
                  return (
                    <span key={uid} className="bg-white border border-slate-200 text-slate-600 px-2 py-1 rounded-lg text-[10px] font-bold flex items-center gap-1">
                      {u?.name}
                      {!readOnly && <button onClick={() => setData({ ...data, participantIds: (data.participantIds || []).filter(id => id !== uid) })}><X size={10}/></button>}
                    </span>
                  );
                })}
                <select 
                  disabled={readOnly}
                  className="bg-transparent text-xs font-bold outline-none text-slate-400 w-24 disabled:opacity-50"
                  value=""
                  onChange={e => {
                    if (e.target.value && !(data.participantIds || []).includes(e.target.value)) {
                      setData({ ...data, participantIds: [...(data.participantIds || []), e.target.value] });
                    }
                  }}
                >
                  <option value="">+ 添加</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex-1 space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">审批人</label>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl min-h-[42px] flex flex-wrap gap-2">
                {(data.approverIds || []).map(uid => {
                  const u = users.find(user => user.id === uid);
                  return (
                    <span key={uid} className="bg-white border border-slate-200 text-slate-600 px-2 py-1 rounded-lg text-[10px] font-bold flex items-center gap-1">
                      {u?.name}
                      {!readOnly && <button onClick={() => setData({ ...data, approverIds: (data.approverIds || []).filter(id => id !== uid) })}><X size={10}/></button>}
                    </span>
                  );
                })}
                <select 
                  disabled={readOnly}
                  className="bg-transparent text-xs font-bold outline-none text-slate-400 w-24 disabled:opacity-50"
                  value=""
                  onChange={e => {
                    if (e.target.value && !(data.approverIds || []).includes(e.target.value)) {
                      setData({ ...data, approverIds: [...(data.approverIds || []), e.target.value] });
                    }
                  }}
                >
                  <option value="">+ 添加</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">标签 (Tags)</label>
            <input 
              disabled={readOnly}
              className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none disabled:opacity-50"
              placeholder="输入标签，用逗号分隔..."
              value={(data.tags || []).join(', ')}
              onChange={e => setData({ ...data, tags: e.target.value.split(/[,，]/).map(t => t.trim()).filter(Boolean) })}
            />
          </div>

          <div className="flex gap-4">
            <div className="flex-1 space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">负责人</label>
              <select 
                disabled={readOnly}
                className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none disabled:opacity-50"
                value={data.ownerId || ''}
                onChange={e => {
                  setData({ ...data, ownerId: e.target.value });
                  if (error) setError(null);
                }}
              >
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div className="flex-1 space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">所属部门</label>
              <select 
                disabled={readOnly}
                className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none disabled:opacity-50"
                value={data.departmentId || ''}
                onChange={e => setData({ ...data, departmentId: e.target.value })}
              >
                <option value="">未分配</option>
                {departments.map(dept => (
                  <option key={dept.id} value={dept.id}>{dept.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-4">
            <div className="flex-1 space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">可见范围</label>
              <select 
                disabled={readOnly}
                className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none disabled:opacity-50"
                value={data.visibility || 'public'}
                onChange={e => setData({ ...data, visibility: e.target.value as any })}
              >
                <option value="public">全公司可见</option>
                <option value="department">本部门可见</option>
                <option value="members">仅任务成员可见</option>
                <option value="private">仅自己可见</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">执行周期 (可多选)</label>
            <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto p-2 bg-slate-50 border border-slate-200 rounded-xl custom-scrollbar">
              {periodWeeks.map(week => {
                const isSelected = data.targetWeeks?.includes(week.id);
                return (
                  <button
                    key={week.id}
                    disabled={readOnly}
                    onClick={() => {
                      const current = data.targetWeeks || [];
                      const newTargetWeeks = isSelected 
                        ? current.filter(id => id !== week.id)
                        : [...current, week.id];
                      setData({ ...data, targetWeeks: newTargetWeeks });
                    }}
                    className={`px-3 py-1.5 rounded-lg text-[10px] font-black transition-all disabled:opacity-50 ${
                      isSelected 
                        ? 'bg-brand-500 text-white shadow-sm' 
                        : 'bg-white text-slate-500 border border-slate-200 hover:border-brand-300'
                    }`}
                  >
                    {week.label}
                  </button>
                );
              })}
              {periodWeeks.length === 0 && (
                <span className="text-xs text-slate-400 italic p-2">暂无可选周期</span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">关联关键结果 (KR)</label>
            <select 
              disabled={readOnly}
              className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none disabled:opacity-50"
              value={data.alignedKrId || ''}
              onChange={e => setData({ ...data, alignedKrId: e.target.value })}
            >
              <option value="">未关联</option>
              {groupedAvailableKRs.map(group => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map(opt => <option key={opt.id} value={opt.id}>{opt.name}</option>)}
                </optgroup>
              ))}
            </select>
          </div>

          {isEditing && data.logs && data.logs.length > 0 && (
            <div className="space-y-2 mt-6">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">修改日志</label>
              <div className="bg-slate-50 rounded-xl p-4 space-y-3 max-h-40 overflow-y-auto custom-scrollbar">
                {data.logs.map(log => {
                  const user = users.find(u => u.id === log.userId);
                  return (
                    <div key={log.id} className="flex gap-3 text-xs">
                      <div className="w-6 h-6 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-bold shrink-0">
                        {user?.name?.charAt(0) || '?'}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-700">{user?.name || '未知用户'}</span>
                          <span className="text-slate-400 text-[10px]">{new Date(log.timestamp).toLocaleString()}</span>
                        </div>
                        <p className="text-slate-600 mt-0.5">{log.details}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="p-6 border-t bg-slate-50 rounded-b-[2rem] flex justify-between items-center">
          {readOnly ? (
            <>
              <div />
              <button 
                onClick={onClose}
                className="px-8 py-3 bg-slate-900 text-white rounded-xl font-black text-xs uppercase shadow-xl"
              >
                关闭
              </button>
            </>
          ) : isEditing ? (
            <>
              {onDelete && (
                <button 
                  onClick={() => setShowDeleteConfirm(true)}
                  className="px-6 py-3 bg-red-50 text-red-600 rounded-xl font-black text-xs uppercase hover:bg-red-100 flex items-center gap-2"
                >
                  <Trash2 size={16}/> 删除任务
                </button>
              )}
              {!onDelete && <div />}
              <button 
                onClick={() => handleSave(data.status as string, false)}
                className="px-8 py-3 bg-brand-600 text-white rounded-xl font-black text-xs uppercase shadow-xl hover:bg-brand-700"
              >
                保存更改
              </button>
            </>
          ) : (
            <>
              <button 
                onClick={() => handleSave('draft')}
                className="px-6 py-3 bg-white border border-slate-200 text-slate-600 rounded-xl font-black text-xs uppercase hover:bg-slate-50"
              >
                存草稿
              </button>
              <div className="flex gap-3">
                <button 
                  onClick={() => handleSave('submitted', true)}
                  className="px-6 py-3 bg-slate-900 text-white rounded-xl font-black text-xs uppercase shadow-xl hover:bg-brand-600"
                >
                  提交并继续下一条
                </button>
                <button 
                  onClick={() => handleSave('submitted', false)}
                  className="px-8 py-3 bg-brand-600 text-white rounded-xl font-black text-xs uppercase shadow-xl hover:bg-brand-700"
                >
                  提交
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-slate-900/80 backdrop-blur-md p-4">
          <div className="bg-white rounded-[2.5rem] w-full max-w-sm p-10 shadow-2xl text-center animate-in zoom-in-95">
            <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6">
              <AlertCircle size={32} />
            </div>
            <h3 className="text-xl font-black text-slate-800 mb-2">确认删除此任务？</h3>
            <p className="text-slate-500 text-xs font-medium mb-8 uppercase tracking-widest">此操作无法撤销</p>
            <div className="flex gap-3">
              <button 
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-xs uppercase hover:bg-slate-200 transition-all"
              >
                取消
              </button>
              <button 
                onClick={() => {
                  setShowDeleteConfirm(false);
                  onDelete?.();
                }}
                className="flex-1 py-3 bg-red-500 text-white rounded-xl font-black text-xs uppercase shadow-lg shadow-red-200 hover:bg-red-600 transition-all"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskModal;
