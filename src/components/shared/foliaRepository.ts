// src/components/shared/foliaRepository.ts
// 本二创版的仓库入口。地址只在这里声明一份：帮助页「加入社区」、遇到问题弹窗和二维码登录诊断共用。

export const FOLIA_REPOSITORY_URL = 'https://github.com/2706521883-lgtm/folia-qishui';

// Electron 里 <a target="_blank"> 会开一个新的 BrowserWindow，必须走主进程交给系统浏览器。
export const openFoliaRepository = () => {
    if (window.electron?.openExternalUrl) {
        void window.electron.openExternalUrl(FOLIA_REPOSITORY_URL);
        return;
    }

    window.open(FOLIA_REPOSITORY_URL, '_blank', 'noopener,noreferrer');
};
