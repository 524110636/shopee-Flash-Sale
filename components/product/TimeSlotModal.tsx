import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/entrypoints/popup/store';
import type { TimeSlot } from '@/entrypoints/popup/types';

interface TimeSlotModalProps {
  onSelect: (slot: TimeSlot) => void;
  onClose: () => void;
}

export function TimeSlotModal({ onSelect, onClose }: TimeSlotModalProps) {
  const { fetchTimeSlots } = useAppStore();
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchTimeSlots()
      .then(list => {
        // 按 start_time 升序
        list.sort((a, b) => a.start_time - b.start_time);
        setSlots(list);
        setLoading(false);
      })
      .catch(e => {
        setError(e?.message || '获取场次失败');
        setLoading(false);
      });
  }, []);

  const nowSec = Math.floor(Date.now() / 1000);

  const fmtTs = (ts: number) => {
    const d = new Date(ts * 1000);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${mi}`;
  };

  const getStatus = (s: TimeSlot): { label: string; cls: string } => {
    if (s.start_time <= nowSec && s.end_time > nowSec) return { label: '进行中', cls: 'text-green-600 bg-green-50 border-green-200' };
    if (s.end_time <= nowSec) return { label: '已结束', cls: 'text-gray-400 bg-gray-50 border-gray-200' };
    return { label: '未开始', cls: 'text-blue-600 bg-blue-50 border-blue-200' };
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-[480px] max-w-[95vw] flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between gap-3 p-4 border-b shrink-0">
          <div>
            <h3 className="text-sm font-medium">选择申报场次</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">共 {slots.length} 个可用场次</p>
          </div>
          <button className="text-lg leading-none text-muted-foreground hover:text-foreground shrink-0" onClick={onClose}>×</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {loading ? (
            <div className="text-xs text-muted-foreground text-center py-8">加载场次列表中...</div>
          ) : error ? (
            <div className="text-xs text-red-500 text-center py-4">{error}</div>
          ) : slots.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">暂无可用场次</div>
          ) : (
            <div className="space-y-1">
              {slots.map(s => {
                const st = getStatus(s);
                return (
                  <div
                    key={s.timeslot_id}
                    className="flex items-center justify-between px-3 py-2 text-xs border rounded-md hover:bg-accent/50 cursor-pointer transition-colors"
                    onClick={() => onSelect(s)}
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="font-medium">场次 #{s.timeslot_id}</span>
                      <span className="text-[10px] text-muted-foreground mt-0.5">
                        {fmtTs(s.start_time)} ~ {fmtTs(s.end_time)}
                      </span>
                    </div>
                    <span className={`px-1.5 py-0.5 text-[10px] rounded-full border shrink-0 ${st.cls}`}>
                      {st.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="p-3 border-t text-[10px] text-muted-foreground shrink-0">
          点击场次即可选择，选择后可在启动前随时更改
        </div>
      </div>
    </div>
  );
}
