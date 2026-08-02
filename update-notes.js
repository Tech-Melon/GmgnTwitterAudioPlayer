/**
 * 版本更新说明（单一数据源）
 * - update.html 新标签页展示
 * - 发版时：改 manifest.version + 在此追加最新版本条目
 */
// eslint-disable-next-line no-unused-vars
const GMGN_UPDATE_NOTES = {
    '1.13.4': [
        '修复：配置加载后重放排队推特消息崩溃（processTwitterMessage 未定义）',
        '修复：Offscreen 同通道打断时 Promise 挂起导致调度器卡死',
        '更新说明页空白修复（外置脚本）',
        '后台播报 / 多开 Leader / 代币名长度限制等 1.13 系列能力'
    ],
    '1.13.3': [
        '修复更新说明页空白：MV3 禁止内联脚本，已改为外置 update-page.js',
        '更新后自动打开新标签页展示本版改动与历史版本',
        '系统设置可手动「查看更新说明」',
        '后台 Offscreen 播报 + 多开前台 Leader 优先'
    ],
    '1.13.2': [
        '更新后自动打开新标签页展示更新说明（无需先点图标）',
        '更新说明页可一键回到盯盘相关提示',
        '修复更新说明依赖 Service Worker / popup 才可见的问题',
        '后台 Offscreen 播报 + 多开前台 Leader 优先（沿用 1.13.x）'
    ],
    '1.13.1': [
        '修复：更新说明弹窗可靠弹出（对比 manifest 版本）',
        '系统设置可随时「查看更新说明」',
        '后台播报 Offscreen：单开/全后台/多开前台均可出声',
        '多开时前台 GMGN 优先接管 Leader'
    ],
    '1.13.0': [
        '后台播报：单开/多开全后台时通过 Offscreen 继续发声',
        '多开时前台 GMGN 优先接管 Leader，其它页后台待命',
        '页内 NotAllowed 自动降级 Offscreen，减少静音',
        '钱包代币名最长默认 15 字可调'
    ],
    '1.12.0': [
        '钱包播报代币名默认最长 15 字，可在钱包监控设置中调整',
        '推特专属铃与 TTS 双通道并行，互不打断',
        '新增：已备注但无专属音账号播报开关',
        '语速统一为「闪电」，废弃旧语速档位'
    ],
    '1.11.0': [
        '推特专属铃与 TTS 双通道并行，互不打断',
        '新增：已备注但无专属音账号播报开关',
        '语速统一为「闪电」，废弃旧语速档位',
        '修复系统设置中推特/钱包单独开关无法可靠关闭',
        '插件更新后自动展示本说明'
    ]
};

function gmgnGetNotesForVersion(version) {
    const notes = typeof GMGN_UPDATE_NOTES !== 'undefined' ? GMGN_UPDATE_NOTES : {};
    if (notes[version]) return notes[version];
    const keys = Object.keys(notes).sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            const d = (pb[i] || 0) - (pa[i] || 0);
            if (d) return d;
        }
        return 0;
    });
    return notes[keys[0]] || ['本次更新包含体验与稳定性优化。'];
}

function gmgnSortedVersions() {
    const notes = typeof GMGN_UPDATE_NOTES !== 'undefined' ? GMGN_UPDATE_NOTES : {};
    return Object.keys(notes).sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            const d = (pb[i] || 0) - (pa[i] || 0);
            if (d) return d;
        }
        return 0;
    });
}
