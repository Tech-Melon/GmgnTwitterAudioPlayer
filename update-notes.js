/**
 * 版本更新说明（单一数据源）
 * - update.html 新标签页展示
 * - 发版时：改 manifest.version + 在此追加最新版本条目
 * 文案面向普通用户，少写技术实现细节
 */
// eslint-disable-next-line no-unused-vars
const GMGN_UPDATE_NOTES = {
    // 今日汇总（用户打开最新版看到的主列表）
    '1.14.0': [
        '多开页面统一协调和自动接管，修复推特、钱包重复播报与漏播',
        '钱包卖出只播一次最终减仓或清仓结果，不同代币的过滤和去重互不影响',
        '钱包改为“备注名 + 动作和代币名”两段渐进播报，降低等待感和段间卡顿',
        '高峰消息按实际播放完成回执排队和合并，减少积压延迟',
        '新增默认关闭的端到端诊断日志，排查时才申请本地日志权限'
    ],
    '1.13.5': [
        'AI 语速恢复三档可选：较快、极快、闪电',
        '推特 / 钱包可各自设置语速，默认仍为闪电',
        '试听与实际播报都会按所选语速生效'
    ],
    '1.13.4': [
        '切到其它网页也能继续播报（单开、多开全后台都支持）',
        '多开 GMGN 时：当前正在看的页面优先出声，其它页不抢播',
        '推特：专属铃声与 AI 念名可同时响，互不打断',
        '未单独配置铃声的账号，默认用 AI 念昵称提醒',
        '可单独开关「已备注但没绑专属音」的账号是否提醒',
        '钱包播报：代币名默认最多念 15 个字，可在设置里改',
        'AI 语速统一为「闪电」，听感更快',
        '系统设置里推特 / 钱包开关可真正关掉对应播报',
        '插件更新后自动打开本说明页，方便查看改了什么'
    ],
    '1.13.3': [
        '修复更新说明页内容不显示的问题'
    ],
    '1.13.2': [
        '安装或升级后自动打开更新说明页'
    ],
    '1.13.1': [
        '优化更新提示，设置里可随时查看更新说明'
    ],
    '1.13.0': [
        '后台页面也能继续语音播报',
        '多开页面时前台优先出声'
    ],
    '1.12.0': [
        '钱包播报支持限制代币名长度（默认 15 字）'
    ],
    '1.11.0': [
        '推特专属铃声与 AI 念名分开处理',
        '新增「已备注但无专属音」提醒开关',
        '修复推特 / 钱包单独开关偶发关不掉'
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
    return notes[keys[0]] || ['本次更新优化了使用体验与稳定性。'];
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
