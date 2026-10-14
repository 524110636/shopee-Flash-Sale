import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import * as popupApi from '../api/popup';
import type { PopupRecord, PopupRecordStatus } from '../api/popup';
import { useToken } from '../auth/AuthContext';
import { PopupEditorModal, type PopupEditorSubmit } from '../components/PopupEditorModal';
import { PopupViewersModal } from '../components/PopupViewersModal';
import { PopupVersionGuide } from '../components/PopupVersionGuide';

/**
 * 弹窗管理页。
 *
 * 默认是**列表**（总数／标题／类型／状态／操作），「新建弹窗」开空白编辑窗口。
 * 编辑／发布／撤回全部按 recordId 定位 —— 不能只按 mode 写固定行，否则
 * 多条记录会互相覆盖。
 *
 * 标题下带绿色累计查看人数，点击只向当前管理员拉账号与首次查看时间明细。
 */

const STATUS_TAG: Record<PopupRecordStatus, { color: string; text: string }> = {
  published: { color: 'green', text: '已发布' },
  withdrawn: { color: 'default', text: '已撤回' },
  draft: { color: 'blue', text: '草稿' },
};

export function PopupPage() {
  const token = useToken();
  const [records, setRecords] = useState<PopupRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PopupRecord | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** 正在查看明细的记录；null 表示窗口关闭。 */
  const [viewersRecord, setViewersRecord] = useState<PopupRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await popupApi.listPopupRecords(token);
      setRecords(result.records);
      setTotal(result.total);
    } catch (e) {
      // 失败只记错误、**不动 records/total**：任务书要求「保留已有列表／人数，
      // 不清空或显示假 0」，否则刷新失败会让管理员以为记录没了。
      setLoadError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = () => {
    // 新建永远是空白：editing = null 让弹窗把表单重置为 EMPTY_FORM，
    // 用户不需要先手动清空上一条内容。
    setEditing(null);
    setEditorOpen(true);
  };

  const handleEdit = (record: PopupRecord) => {
    setEditing(record);
    setEditorOpen(true);
  };

  const handleSubmit = async (values: PopupEditorSubmit) => {
    try {
      if (editing) {
        await popupApi.savePopupDraft(token, editing.recordId, values);
        message.success('已保存');
      } else {
        await popupApi.createPopupRecord(token, values);
        message.success('已新建');
      }
      setEditorOpen(false);
      setEditing(null);
      await load();
    } catch (e) {
      // 失败时不关闭弹窗，用户输入不丢。
      message.error(e instanceof Error ? e.message : '保存失败');
    }
  };

  const handlePublish = async (record: PopupRecord) => {
    setBusyId(record.recordId);
    try {
      // 先把当前编辑器里的内容存成草稿，再发布 —— 否则发布的是上一次保存的内容。
      const result = await popupApi.publishPopup(token, record.recordId);
      if (result.replacedTitle) {
        message.warning(`已替换同类型的生效内容：「${result.replacedTitle}」已转为已撤回（记录保留）`);
      } else {
        message.success(`已发布（第 ${result.revision} 次修订）`);
      }
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '发布失败');
    } finally {
      setBusyId(null);
    }
  };

  const handleWithdraw = async (record: PopupRecord) => {
    setBusyId(record.recordId);
    try {
      await popupApi.withdrawPopup(token, record.recordId);
      message.success('已撤回，扩展下次打开时不再展示该内容');
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '撤回失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="弹窗只在扩展内展示"
        description={
          <span>
            勾选「强制更新」的弹窗无法取消，必须点「下载最新版本」跳转到你填写的地址；扩展会按<strong>实际加载的包版本</strong>判断是否解除阻挡。
            每种类型同时只展示一条，发布另一条同类型内容会替换当前那条并给出提示。正在运行的任务与已安排的定时任务不会因弹窗而停止。
          </span>
        }
      />

      <PopupVersionGuide />

      <Card
        size="small"
        title={`弹窗列表（共 ${total} 条）`}
        extra={
          <Space size={8}>
            {/* 刷新：只重新拉列表（含每条 viewCount），不刷新整页、不动编辑状态。
                用 loading 防连续点击；失败由 load() 里的 loadError 分支给出提示与重试。 */}
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => void load()}
            >
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              新建弹窗
            </Button>
          </Space>
        }
      >
        {/* 失败提示放在列表**上方**，而不是替换列表：
            任务书要求「失败保留已有列表／人数，不清空或显示假 0」。
            用替换式渲染会把上一次成功加载的列表整块藏起来，人看到的就是空列表。 */}
        {loadError && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message="加载弹窗列表失败"
            description={
              <span>
                {loadError}
                <br />
                {total > 0 || records.length > 0
                  ? '当前仍显示上一次成功加载的数据；点「重试」可再拉一次。'
                  : '目前还没有可显示的数据；点「重试」可再拉一次。'}
              </span>
            }
            action={<Button size="small" loading={loading} onClick={() => void load()}>重试</Button>}
          />
        )}
        <Table<PopupRecord>
          rowKey="recordId"
          loading={loading}
          dataSource={records}
          pagination={false}
          size="small"
          locale={{
            // 加载失败且没有任何数据时，不能说「还没有弹窗」——那是假 0。
            emptyText: loadError && records.length === 0
              ? '数据加载失败，暂时无法显示列表'
              : '还没有弹窗，点右上角「新建弹窗」开始',
          }}
          columns={[
            {
              title: '标题',
              dataIndex: ['draft', 'title'],
              render: (_v, record) => (
                <div>
                  <Typography.Text strong={record.status === 'published'}>
                    {record.draft.title || record.published?.title || '（未填标题）'}
                  </Typography.Text>
                  {/* 绿色累计人数：通知与强制都支持，撤回后仍可查看 */}
                  <div style={{ marginTop: 2 }}>
                    <Typography.Link
                      style={{ color: '#389e0d', fontSize: 12 }}
                      onClick={() => setViewersRecord(record)}
                    >
                      共 {record.viewCount} 位用户查看过
                    </Typography.Link>
                  </div>
                </div>
              ),
            },
              {
                title: '类型',
                dataIndex: 'mode',
                width: 110,
                render: (mode: PopupRecord['mode']) =>
                  mode === 'forced_update'
                    ? <Tag color="red">强制更新</Tag>
                    : <Tag color="blue">通知</Tag>,
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 110,
                render: (status: PopupRecordStatus) => {
                  const tag = STATUS_TAG[status];
                  return <Tag color={tag.color}>{tag.text}</Tag>;
                },
              },
              {
                title: '要求版本',
                dataIndex: ['draft', 'requiredVersion'],
                width: 120,
                render: (v: string | null, record) => v || record.published?.requiredVersion || '—',
              },
              {
                title: '操作',
                key: 'actions',
                width: 210,
                render: (_v, record) => (
                  <Space size={4}>
                    <Button size="small" onClick={() => handleEdit(record)}>
                      编辑
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      loading={busyId === record.recordId}
                      onClick={() => handlePublish(record)}
                    >
                      发布
                    </Button>
                    {record.status === 'published' && (
                      <Popconfirm
                        title="确定撤回？"
                        description="撤回后扩展下次打开不再展示该内容，记录与查看统计会保留。"
                        onConfirm={() => handleWithdraw(record)}
                        okText="撤回"
                        cancelText="取消"
                      >
                        <Button size="small" danger loading={busyId === record.recordId}>
                          撤回
                        </Button>
                      </Popconfirm>
                    )}
                  </Space>
                ),
              },
            ]}
          />
      </Card>

      <PopupEditorModal
        open={editorOpen}
        record={editing}
        token={token}
        onCancel={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
        onSubmit={handleSubmit}
      />

      <PopupViewersModal
        open={viewersRecord !== null}
        recordId={viewersRecord?.recordId ?? null}
        recordTitle={viewersRecord?.draft.title || viewersRecord?.published?.title || ''}
        token={token}
        onClose={() => setViewersRecord(null)}
      />
    </Space>
  );
}
