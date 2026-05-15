# SSH 连接服务器

## 服务器信息

- **IP**: `43.99.86.228`
- **端口**: `22`
- **用户**: `root`
- **密码**: `Mm594207.`
- **宝塔面板**: `http://43.99.86.228:8888/` (账号 `c7a59270` / 密码 `ea3b233cda49`)

## 从本机连接

Bash 环境（Git Bash / WSL）下使用以下命令：

```bash
# 1. 创建密码脚本（只需执行一次）
cat > /tmp/pass.sh << 'EOF'
#!/bin/bash
echo 'Mm594207.'
EOF
chmod +x /tmp/pass.sh

# 2. SSH 连接
export SSH_ASKPASS="/tmp/pass.sh"
export DISPLAY=":0"
SSH_ASKPASS_REQUIRE=force ssh \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=10 \
  -o PasswordAuthentication=yes \
  -o PubkeyAuthentication=no \
  root@43.99.86.228
```

## 执行远程命令

```bash
export SSH_ASKPASS="/tmp/pass.sh"; export DISPLAY=":0"; SSH_ASKPASS_REQUIRE=force ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o PasswordAuthentication=yes -o PubkeyAuthentication=no root@43.99.86.228 '你的命令'
```

## 常用运维命令

```bash
# PM2 状态
pm2 list

# 查看后端日志
pm2 logs limited-time-sale --lines 30 --nostream

# 重启后端
pm2 restart limited-time-sale

# 端口监听
ss -tlnp | grep 5724

# 本地健康检查
curl -s http://127.0.0.1:5724/api/health
```

## 项目路径

- **后端代码**: `/www/wwwroot/xp.aluvi.cc/`
- **数据库**: `/www/wwwroot/xp.aluvi.cc/data/sale.db`
- **Nginx 配置**: `/www/server/panel/vhost/nginx/xp.aluvi.cc.conf`
- **反向代理配置**: `/www/server/panel/vhost/nginx/proxy/xp.aluvi.cc/`

## 防火墙

轻量应用服务器使用「防火墙」而非安全组，在阿里云控制台管理。已放行端口：80、443、22、8888、3000、5724。
