import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Modal, Table, Typography } from 'antd';
import * as popupApi from '../api/popup';
import type { PopupViewer } from '../api/popup';

/**
 * 查看人数明细窗口。
 *
 * 只向当前管理员加载账号与首次查看时间。空态显示 0 人（不补造历史），
 * 失败时给可点重试，不把错误吞掉。
 *
 * 口径说明直接写在窗口里：这里的「查看」是**服务器收到过展示上报**的登录账号，
 * 同一账号多设备只算一位，且含该记录历史发布累计。避免管理员误以为
 * 「人数 = 当前修订的在线人数」。
 */

const PAGE_SIZE = 20;

interface Props {
  open: boolean;
  recordId: string | null;
  recordTitle: string;
  token: string;
  onClose: () => void;
}

export function PopupViewersModal({ open, recordId, recordTitle, token, onClose }: Props) {
  const [viewers, setViewers] = useState<PopupViewer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (targetPage: number) => {
      if (!recordId) return;
      setLoading(true);
      setError(null);
      try {
        const result = await popupApi.listPopupViewers(
          token,
          recordId,
          (targetPage - 1) * PAGE_SIZE,
          PAGE_SIZE,
        );
        setViewers(result.viewers);
        setTotal(result.total);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载明细失败');
      } finally {
        setLoading(false);
      }
    },
    [recordId, token],
  );

  // 打开或切换记录时回到第一页重新拉取，避免看到上一条记录的分页残留。
  useEffect(() => {
    if (!open) return;
    setPage(1);
    void load(1);
  }, [open, recordId, load]);

  const handlePageChange = (next: number) => {
    setPage(next);
    void load(next);
  };

  return (
    <Modal
      open={open}
      title={`查看明细 — ${recordTitle || '（未填标题）'}`}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      width={620}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
        共 <strong>{total}</strong> 位登录账号查看过。按登录账号累计去重，含该记录历史发布；
        同账号多设备只算一位。以服务器收到的展示上报为准，离线或关闭过快可能漏记。
      </Typography.Paragraph>

      {error ? (
        <Alert
          type="error"
          showIcon
          message="加载查看明细失败"
          description={error}
          action={
            <Button size="small" onClick={() => void load(page)}>
              重试
            </Button>
          }
        />
      ) : (
        <Table<PopupViewer>
          rowKey="email"
          size="small"
          loading={loading}
          dataSource={viewers}
          locale={{ emptyText: '还没有人查看过这条弹窗' }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            onChange: handlePageChange,
          }}
          columns={[
            { title: '账号', dataIndex: 'email' },
            {
              title: '首次查看时间',
              dataIndex: 'firstViewedAt',
              width: 200,
              render: (v: string) => v || '—',
            },
          ]}
        />
      )}
    </Modal>
  );
}
