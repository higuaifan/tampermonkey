// ==UserScript==
// @name         X.com 多视频播放器 + 内容管理器
// @namespace    http://tampermonkey.net/
// @version      5.8
// @description  多视频播放 + 循环播放 + 自动滚动 + 优雅的内容管理界面，可删除不需要的推文，隐藏文本保留图片，隐藏推荐关注内容
// @author       You
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';
    
    const videoStates = new Map();
    const blockedIntervals = new Set();
    const allowedPauses = new WeakSet();
    const userPausedVideos = new WeakSet();
    const deletedElements = new Set(); // 记录已删除的元素
    const hiddenTextElements = new Set(); // 记录已隐藏文本的元素
    const hiddenRecommendElements = new Set(); // 记录已隐藏推荐内容的元素
    
    let deleteMode = false;
    let textHideMode = false; // 文本隐藏模式
    let recommendHideMode = false; // 推荐内容隐藏模式
    let loopMode = true; // 视频循环模式
    let autoScrollMode = false; // 自动滚动模式
    let muteMode = true; // 默认静音模式
    let scrollInterval = null; // 滚动计时器
    let scrollSpeed = 5; // 滚动速度（像素/次）
    let uiPanel = null;
    
    // === 视频播放功能（保持原有） ===
    
    function interceptVideoTimers() {
        const originalSetInterval = window.setInterval;
        const originalClearInterval = window.clearInterval;
        
        window.setInterval = function(callback, delay) {
            const callbackStr = callback.toString();
            
            if (delay === 100 && (
                callbackStr.includes('waitingForPlayback') ||
                callbackStr.includes('_clearPlaybackWait') ||
                callbackStr.includes('playback') ||
                callbackStr.includes('fragCurrent') ||
                callbackStr.includes('partCurrent')
            )) {
                const fakeId = Math.random() * 10000;
                blockedIntervals.add(fakeId);
                return fakeId;
            }
            
            if (callbackStr.includes('video') && (
                callbackStr.includes('pause') ||
                callbackStr.includes('stop') ||
                callbackStr.includes('playing')
            )) {
                const fakeId = Math.random() * 10000;
                blockedIntervals.add(fakeId);
                return fakeId;
            }
            
            return originalSetInterval.call(this, callback, delay);
        };
        
        window.clearInterval = function(id) {
            if (blockedIntervals.has(id)) {
                blockedIntervals.delete(id);
                return;
            }
            return originalClearInterval.call(this, id);
        };
    }
    
    function interceptPauseCalls() {
        const originalPause = HTMLVideoElement.prototype.pause;
        
        HTMLVideoElement.prototype.pause = function() {
            if (allowedPauses.has(this) || userPausedVideos.has(this)) {
                allowedPauses.delete(this);
                const state = videoStates.get(this);
                if (state) state.shouldBePlaying = false;
                return originalPause.call(this);
            }
            
            const stack = new Error().stack;
            const isAutoPause = stack.includes('setInterval') || 
                              stack.includes('_clearPlaybackWait') ||
                              stack.includes('waitingForPlayback') ||
                              (!stack.includes('user-script') && !stack.includes('click'));
            
            if (isAutoPause && !this.paused) {
                return Promise.resolve();
            }
            
            const state = videoStates.get(this);
            if (state) state.shouldBePlaying = false;
            return originalPause.call(this);
        };
    }
    
    function enhancePlayMethod() {
        const originalPlay = HTMLVideoElement.prototype.play;
        
        HTMLVideoElement.prototype.play = function() {
            videoStates.set(this, {
                shouldBePlaying: true,
                lastPlayTime: Date.now(),
                element: this
            });
            
            userPausedVideos.delete(this);
            const playPromise = originalPlay.call(this);
            
            setTimeout(() => {
                this.protectOtherVideos();
            }, 150);
            
            return playPromise;
        };
        
        HTMLVideoElement.prototype.protectOtherVideos = function() {
            document.querySelectorAll('video').forEach(video => {
                if (video !== this) {
                    const state = videoStates.get(video);
                    if (state && state.shouldBePlaying && video.paused && !userPausedVideos.has(video)) {
                        video.play().catch(e => {});
                    }
                }
            });
        };
    }
    
    function setupUserInteraction() {
        document.addEventListener('click', (e) => {
            // 如果点击的是删除按钮
            if (e.target.classList.contains('tweet-delete-btn') || e.target.closest('.tweet-delete-btn')) {
                handleDeleteButtonClick(e);
                return;
            }
            
            // 原有的视频播放逻辑
            let targetVideo = null;
            
            if (e.target.tagName === 'VIDEO') {
                targetVideo = e.target;
            } else {
                const videoContainer = e.target.closest('[data-testid*="video"], [aria-label*="视频"], [aria-label*="Video"]');
                if (videoContainer) {
                    targetVideo = videoContainer.querySelector('video');
                }
            }
            
            if (targetVideo) {
                if (targetVideo.paused) {
                    userPausedVideos.delete(targetVideo);
                    targetVideo.play();
                } else {
                    userPausedVideos.add(targetVideo);
                    allowedPauses.add(targetVideo);
                    targetVideo.pause();
                }
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
        
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                const videos = document.querySelectorAll('video');
                const playingVideos = Array.from(videos).filter(v => !v.paused);
                
                if (playingVideos.length > 0) {
                    playingVideos.forEach(video => {
                        userPausedVideos.add(video);
                        allowedPauses.add(video);
                        video.pause();
                    });
                    e.preventDefault();
                }
            }
        });
    }
    
    function setupAutoPlay() {
        function handleNewVideos() {
            document.querySelectorAll('video').forEach(video => {
                if (!video.hasAttribute('data-processed')) {
                    video.setAttribute('data-processed', 'true');

                    // 如果循环模式开启，设置video的loop属性
                    if (loopMode) {
                        video.loop = true;
                    }

                    // 如果静音模式开启，设置video的muted属性
                    if (muteMode) {
                        video.muted = true;
                    }

                    const tryAutoPlay = () => {
                        if (video.readyState >= 2 && video.paused && !userPausedVideos.has(video)) {
                            const rect = video.getBoundingClientRect();
                            const isVisible = rect.top < window.innerHeight && rect.bottom > 0;

                            if (isVisible) {
                                video.play().catch(e => {});
                            }
                        }
                    };

                    video.addEventListener('loadeddata', tryAutoPlay);
                    video.addEventListener('canplay', tryAutoPlay);
                    video.addEventListener('loadedmetadata', tryAutoPlay);

                    setTimeout(tryAutoPlay, 500);
                    setTimeout(tryAutoPlay, 1000);
                }
            });
        }
        
        handleNewVideos();
        const observer = new MutationObserver(handleNewVideos);
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }
    
    function setupMonitoring() {
        setInterval(() => {
            videoStates.forEach((state, video) => {
                if (state.shouldBePlaying && video.paused && !userPausedVideos.has(video)) {
                    const timeSincePlay = Date.now() - state.lastPlayTime;
                    if (timeSincePlay > 2000) {
                        video.play().catch(e => {});
                        state.lastPlayTime = Date.now();
                    }
                }
            });
        }, 3000);
    }
    
    function setupVisibilityHandling() {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const video = entry.target;
                if (!entry.isIntersecting) {
                    allowedPauses.add(video);
                    video.pause();
                    const state = videoStates.get(video);
                    if (state) state.shouldBePlaying = false;
                }
            });
        }, { threshold: 0.1 });
        
        function observeVideos() {
            document.querySelectorAll('video').forEach(video => {
                if (!video.hasAttribute('data-observed')) {
                    video.setAttribute('data-observed', 'true');
                    observer.observe(video);
                }
            });
        }
        
        observeVideos();
        const mutationObserver = new MutationObserver(observeVideos);
        if (document.body) {
            mutationObserver.observe(document.body, { childList: true, subtree: true });
        }
    }
    
    function blockOtherControls() {
        if ('mediaSession' in navigator) {
            try {
                navigator.mediaSession.setActionHandler('pause', null);
                navigator.mediaSession.setActionHandler('stop', null);
            } catch (e) {}
        }
        
        document.addEventListener('pause', (e) => {
            if (e.target.tagName === 'VIDEO' && !allowedPauses.has(e.target) && !userPausedVideos.has(e.target)) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        }, true);
    }
    
    // === 新增：优雅的UI界面 ===
    
    function createUI() {
        // 创建浮动控制面板
        uiPanel = document.createElement('div');
        uiPanel.id = 'tweet-manager-panel';
        uiPanel.classList.add('collapsed'); // 默认折叠状态
        uiPanel.innerHTML = `
            <div class="panel-header">
                <div class="panel-title">
                    <span class="title-icon">🎬</span>
                    <span class="title-text">内容管理器</span>
                </div>
                <button class="panel-toggle" id="panel-toggle">+</button>
            </div>
            <div class="panel-content" id="panel-content" style="display: none;">
                <div class="feature-section">
                    <h3>🎥 视频控制</h3>
                    <div class="button-group">
                        <button class="control-btn play-all" id="play-all">播放全部</button>
                        <button class="control-btn pause-all" id="pause-all">暂停全部</button>
                    </div>
                    <div class="button-group">
                        <button class="control-btn mute-all" id="mute-all">静音全部</button>
                        <button class="control-btn unmute-all" id="unmute-all">取消静音</button>
                    </div>
                    <div class="button-group">
                        <button class="control-btn loop-mode" id="loop-mode">
                            <span class="loop-icon">🔁</span>
                            <span class="loop-text">开启循环</span>
                        </button>
                        <button class="control-btn mute-mode" id="mute-mode">
                            <span class="mute-icon">🔇</span>
                            <span class="mute-text">默认静音</span>
                        </button>
                    </div>
                    <div class="button-group">
                        <button class="control-btn auto-scroll" id="auto-scroll">
                            <span class="scroll-icon">📜</span>
                            <span class="scroll-text">自动滚动</span>
                        </button>
                    </div>
                    <div class="scroll-controls" id="scroll-controls" style="display: none;">
                        <label class="speed-label">滚动速度:</label>
                        <div class="speed-buttons">
                            <button class="speed-btn" data-speed="1">慢</button>
                            <button class="speed-btn active" data-speed="5">中</button>
                            <button class="speed-btn" data-speed="10">快</button>
                        </div>
                        <input type="range" id="speed-slider" min="1" max="20" value="5" class="speed-slider">
                        <span class="speed-display" id="speed-display">5px/次</span>
                    </div>
                    <div class="status" id="video-status">
                        视频: <span id="video-count">0</span> 个 | 循环: <span id="loop-status">关闭</span> | 静音: <span id="mute-status">开启</span> | 滚动: <span id="scroll-status">关闭</span>
                    </div>
                </div>
                
                <div class="feature-section">
                    <h3>🗑️ 内容清理</h3>
                    <div class="button-group">
                        <button class="control-btn delete-mode active" id="delete-mode">
                            <span class="delete-icon">🔥</span>
                            <span class="delete-text">退出删除</span>
                        </button>
                        <button class="control-btn restore-all" id="restore-all">恢复全部</button>
                    </div>
                    <div class="status">
                        已删除: <span id="deleted-count">0</span> 条推文
                    </div>
                </div>
                
                <div class="feature-section">
                    <h3>📝 文本管理</h3>
                    <div class="button-group">
                        <button class="control-btn text-hide-mode active" id="text-hide-mode">
                            <span class="text-hide-icon">🙈</span>
                            <span class="text-hide-text">退出隐藏</span>
                        </button>
                        <button class="control-btn restore-text" id="restore-text">恢复文本</button>
                    </div>
                    <div class="status">
                        已隐藏: <span id="hidden-text-count">0</span> 条文本
                    </div>
                </div>
                
                <div class="feature-section">
                    <h3>👥 推荐管理</h3>
                    <div class="button-group">
                        <button class="control-btn recommend-hide-mode active" id="recommend-hide-mode">
                            <span class="recommend-hide-icon">✅</span>
                            <span class="recommend-hide-text">退出隐藏</span>
                        </button>
                        <button class="control-btn restore-recommend" id="restore-recommend">恢复推荐</button>
                    </div>
                    <div class="status">
                        已隐藏: <span id="hidden-recommend-count">0</span> 条推荐
                    </div>
                </div>
                
                <div class="feature-section">
                    <h3>⚡ 快捷操作</h3>
                    <div class="tips">
                        <div class="tip">• 点击视频播放/暂停</div>
                        <div class="tip">• 空格键暂停所有视频</div>
                        <div class="tip">• 点击红色按钮删除推文</div>
                        <div class="tip">• 隐藏文本保留图片</div>
                        <div class="tip">• 隐藏推荐关注内容</div>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(uiPanel);
        
        // 默认启用删除模式（但不显示提示）
        deleteMode = true;
        document.body.classList.add('delete-mode-active');
        
        // 默认启用文本隐藏模式
        textHideMode = true;
        document.body.classList.add('text-hide-mode-active');
        
        // 默认启用推荐隐藏模式
        recommendHideMode = true;
        document.body.classList.add('recommend-hide-mode-active');

        // 默认启用循环模式，设置按钮状态
        const loopBtn = document.getElementById('loop-mode');
        loopBtn.classList.add('active');
        const loopIcon = loopBtn.querySelector('.loop-icon');
        const loopText = loopBtn.querySelector('.loop-text');
        loopIcon.textContent = '🔄';
        loopText.textContent = '关闭循环';

        // 默认启用静音模式，设置按钮状态
        const muteBtn = document.getElementById('mute-mode');
        muteBtn.classList.add('active');
        const muteIcon = muteBtn.querySelector('.mute-icon');
        const muteText = muteBtn.querySelector('.mute-text');
        muteIcon.textContent = '🔊';
        muteText.textContent = '关闭静音';

        // 绑定事件
        setupUIEvents();
        
        // 定期更新状态
        setInterval(updateStatus, 1000);
        
        // 延迟添加删除按钮，确保页面加载完成
        setTimeout(() => {
            addDeleteButtons();
        }, 500);
        
        // 延迟执行默认隐藏功能，确保页面加载完成
        setTimeout(() => {
            hideAllTexts();
            hideAllRecommends();
        }, 1000);
    }
    
    function setupUIEvents() {
        // 面板折叠/展开
        document.getElementById('panel-toggle').addEventListener('click', () => {
            const content = document.getElementById('panel-content');
            const toggle = document.getElementById('panel-toggle');
            
            if (content.style.display === 'none') {
                content.style.display = 'block';
                toggle.textContent = '−';
                uiPanel.classList.remove('collapsed');
            } else {
                content.style.display = 'none';
                toggle.textContent = '+';
                uiPanel.classList.add('collapsed');
            }
        });
        
        // 播放全部视频
        document.getElementById('play-all').addEventListener('click', () => {
            document.querySelectorAll('video').forEach(video => {
                userPausedVideos.delete(video);
                if (video.paused) {
                    video.play();
                }
            });
        });
        
        // 暂停全部视频
        document.getElementById('pause-all').addEventListener('click', () => {
            document.querySelectorAll('video').forEach(video => {
                userPausedVideos.add(video);
                allowedPauses.add(video);
                video.pause();
            });
        });

        // 静音全部视频
        document.getElementById('mute-all').addEventListener('click', () => {
            document.querySelectorAll('video').forEach(video => {
                video.muted = true;
            });
        });

        // 取消静音全部视频
        document.getElementById('unmute-all').addEventListener('click', () => {
            document.querySelectorAll('video').forEach(video => {
                video.muted = false;
            });
        });

        // 循环模式切换
        document.getElementById('loop-mode').addEventListener('click', () => {
            loopMode = !loopMode;
            const btn = document.getElementById('loop-mode');
            const icon = btn.querySelector('.loop-icon');
            const text = btn.querySelector('.loop-text');

            if (loopMode) {
                btn.classList.add('active');
                icon.textContent = '🔄';
                text.textContent = '关闭循环';
                // 给所有现有视频设置循环
                document.querySelectorAll('video').forEach(video => {
                    video.loop = true;
                });
            } else {
                btn.classList.remove('active');
                icon.textContent = '🔁';
                text.textContent = '开启循环';
                // 移除所有视频的循环
                document.querySelectorAll('video').forEach(video => {
                    video.loop = false;
                });
            }
            updateStatus();
        });

        // 静音模式切换
        document.getElementById('mute-mode').addEventListener('click', () => {
            muteMode = !muteMode;
            const btn = document.getElementById('mute-mode');
            const icon = btn.querySelector('.mute-icon');
            const text = btn.querySelector('.mute-text');

            if (muteMode) {
                btn.classList.add('active');
                icon.textContent = '🔊';
                text.textContent = '关闭静音';
                // 给所有现有视频设置静音
                document.querySelectorAll('video').forEach(video => {
                    video.muted = true;
                });
            } else {
                btn.classList.remove('active');
                icon.textContent = '🔇';
                text.textContent = '默认静音';
                // 取消所有视频的静音
                document.querySelectorAll('video').forEach(video => {
                    video.muted = false;
                });
            }
            updateStatus();
        });

        // 自动滚动模式切换
        document.getElementById('auto-scroll').addEventListener('click', () => {
            autoScrollMode = !autoScrollMode;
            const btn = document.getElementById('auto-scroll');
            const icon = btn.querySelector('.scroll-icon');
            const text = btn.querySelector('.scroll-text');

            if (autoScrollMode) {
                btn.classList.add('active');
                icon.textContent = '⏸️';
                text.textContent = '停止滚动';
                document.getElementById('scroll-controls').style.display = 'block';
                startAutoScroll();
            } else {
                btn.classList.remove('active');
                icon.textContent = '📜';
                text.textContent = '自动滚动';
                document.getElementById('scroll-controls').style.display = 'none';
                stopAutoScroll();
            }
            updateStatus();
        });

        // 滚动速度控制
        const speedButtons = document.querySelectorAll('.speed-btn');
        speedButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const speed = parseInt(btn.dataset.speed);
                setScrollSpeed(speed);
                speedButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        const speedSlider = document.getElementById('speed-slider');
        speedSlider.addEventListener('input', (e) => {
            const speed = parseInt(e.target.value);
            setScrollSpeed(speed);
            // 更新按钮状态
            speedButtons.forEach(b => b.classList.remove('active'));
            if (speed === 1) speedButtons[0].classList.add('active');
            else if (speed === 5) speedButtons[1].classList.add('active');
            else if (speed === 10) speedButtons[2].classList.add('active');
        });

        // 删除模式切换
        document.getElementById('delete-mode').addEventListener('click', () => {
            deleteMode = !deleteMode;
            const btn = document.getElementById('delete-mode');
            const icon = btn.querySelector('.delete-icon');
            const text = btn.querySelector('.delete-text');
            
            if (deleteMode) {
                btn.classList.add('active');
                icon.textContent = '🔥';
                text.textContent = '退出删除';
                document.body.classList.add('delete-mode-active');
                addDeleteButtons();
                // 只在用户主动激活时显示提示
                showDeleteHint();
            } else {
                btn.classList.remove('active');
                icon.textContent = '✂️';
                text.textContent = '删除模式';
                document.body.classList.remove('delete-mode-active');
                removeDeleteButtons();
                hideDeleteHint();
            }
        });
        
        // 恢复全部
        document.getElementById('restore-all').addEventListener('click', () => {
            deletedElements.forEach(element => {
                if (element.parentNode) {
                    element.style.display = '';
                    element.classList.remove('deleted-tweet');
                }
            });
            deletedElements.clear();
            updateStatus();
        });
        
        // 文本隐藏模式切换
        document.getElementById('text-hide-mode').addEventListener('click', () => {
            textHideMode = !textHideMode;
            const btn = document.getElementById('text-hide-mode');
            const icon = btn.querySelector('.text-hide-icon');
            const text = btn.querySelector('.text-hide-text');
            
            if (textHideMode) {
                btn.classList.add('active');
                icon.textContent = '🙈';
                text.textContent = '退出隐藏';
                document.body.classList.add('text-hide-mode-active');
                hideAllTexts();
                showTextHideHint();
            } else {
                btn.classList.remove('active');
                icon.textContent = '👁️';
                text.textContent = '隐藏文本';
                document.body.classList.remove('text-hide-mode-active');
                restoreAllTexts();
                hideTextHideHint();
            }
        });
        
        // 恢复所有文本
        document.getElementById('restore-text').addEventListener('click', () => {
            hiddenTextElements.forEach(tweet => {
                if (tweet.parentNode) {
                    if (tweet.classList.contains('hidden-text-full')) {
                        // 恢复整个推文
                        tweet.style.display = '';
                        tweet.classList.remove('hidden-text-full');
                    } else {
                        // 恢复文本容器
                        const textContainer = tweet.querySelector('[data-testid="tweetText"]');
                        if (textContainer) {
                            textContainer.style.display = '';
                            textContainer.classList.remove('hidden-text');
                        }
                    }
                }
            });
            hiddenTextElements.clear();
            updateStatus();
        });
        
        // 推荐内容隐藏模式切换
        document.getElementById('recommend-hide-mode').addEventListener('click', () => {
            recommendHideMode = !recommendHideMode;
            const btn = document.getElementById('recommend-hide-mode');
            const icon = btn.querySelector('.recommend-hide-icon');
            const text = btn.querySelector('.recommend-hide-text');
            
            if (recommendHideMode) {
                btn.classList.add('active');
                icon.textContent = '✅';
                text.textContent = '退出隐藏';
                document.body.classList.add('recommend-hide-mode-active');
                hideAllRecommends();
                showRecommendHideHint();
            } else {
                btn.classList.remove('active');
                icon.textContent = '🚫';
                text.textContent = '隐藏推荐';
                document.body.classList.remove('recommend-hide-mode-active');
                restoreAllRecommends();
                hideRecommendHideHint();
            }
        });
        
        // 恢复所有推荐内容
        document.getElementById('restore-recommend').addEventListener('click', () => {
            hiddenRecommendElements.forEach(element => {
                if (element.parentNode) {
                    element.style.display = '';
                    element.classList.remove('hidden-recommend');
                }
            });
            hiddenRecommendElements.clear();
            updateStatus();
        });
    }
    
    function handleDeleteButtonClick(e) {
        // 查找最近的推文容器
        const deleteBtn = e.target.closest('.tweet-delete-btn');
        const tweetElement = deleteBtn.closest('article[data-testid="tweet"], article[role="article"]');
        
        if (tweetElement && !deletedElements.has(tweetElement)) {
            // 添加删除动画
            tweetElement.style.transition = 'all 0.3s ease';
            tweetElement.style.transform = 'scale(0.95)';
            tweetElement.style.opacity = '0.3';
            
            setTimeout(() => {
                tweetElement.style.display = 'none';
                tweetElement.classList.add('deleted-tweet');
                deletedElements.add(tweetElement);
                updateStatus();
                
                // 显示删除成功提示
                showDeleteSuccess();
            }, 300);
            
            e.preventDefault();
            e.stopPropagation();
        }
    }
    
    function hideAllTexts() {
        // 1. 纯文本推文 → 隐藏整个推文
        // 2. 有媒体的推文 → 只隐藏文本部分
        const tweets = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
        tweets.forEach(tweet => {
            if (!hiddenTextElements.has(tweet)) {
                // 检查是否包含图片或视频
                const hasMedia = tweet.querySelector('[data-testid="tweetPhoto"], video, [data-testid="videoPlayer"]');
                const textContainer = tweet.querySelector('[data-testid="tweetText"]');

                if (!hasMedia && textContainer) {
                    // 情况1: 纯文本推文，隐藏整个推文
                    tweet.style.display = 'none';
                    tweet.classList.add('hidden-text-full');
                    hiddenTextElements.add(tweet);
                } else if (hasMedia && textContainer) {
                    // 情况2: 有媒体的推文，只隐藏文本
                    textContainer.style.display = 'none';
                    textContainer.classList.add('hidden-text');
                    hiddenTextElements.add(tweet);
                }
            }
        });

        // 启动监控新推文的出现
        startTextHideObserver();
    }
    
    function restoreAllTexts() {
        // 恢复所有隐藏的内容
        hiddenTextElements.forEach(tweet => {
            if (tweet.classList.contains('hidden-text-full')) {
                // 恢复整个推文
                tweet.style.display = '';
                tweet.classList.remove('hidden-text-full');
            } else {
                // 恢复文本容器
                const textContainer = tweet.querySelector('[data-testid="tweetText"]');
                if (textContainer) {
                    textContainer.style.display = '';
                    textContainer.classList.remove('hidden-text');
                }
            }
        });
        hiddenTextElements.clear();

        // 停止监控
        stopTextHideObserver();
    }
    
    function startTextHideObserver() {
        // 避免重复创建监控器
        if (window.textHideObserver) {
            return;
        }
        
        window.textHideObserver = new MutationObserver(() => {
            if (textHideMode) {
                setTimeout(() => {
                    const newTweets = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
                    newTweets.forEach(tweet => {
                        if (!hiddenTextElements.has(tweet)) {
                            // 检查是否包含图片或视频
                            const hasMedia = tweet.querySelector('[data-testid="tweetPhoto"], video, [data-testid="videoPlayer"]');
                            const textContainer = tweet.querySelector('[data-testid="tweetText"]');

                            if (!hasMedia && textContainer) {
                                // 情况1: 纯文本推文，隐藏整个推文
                                tweet.style.display = 'none';
                                tweet.classList.add('hidden-text-full');
                                hiddenTextElements.add(tweet);
                            } else if (hasMedia && textContainer) {
                                // 情况2: 有媒体的推文，只隐藏文本
                                textContainer.style.display = 'none';
                                textContainer.classList.add('hidden-text');
                                hiddenTextElements.add(tweet);
                            }
                        }
                    });
                }, 100);
            }
        });
        
        if (document.body) {
            window.textHideObserver.observe(document.body, {
                childList: true,
                subtree: true
            });
        }
    }
    
    function stopTextHideObserver() {
        if (window.textHideObserver) {
            window.textHideObserver.disconnect();
            window.textHideObserver = null;
        }
    }
    
    function hideAllRecommends() {
        // 隐藏所有推荐关注和"显示更多"内容
        const recommendSelectors = [
            '[data-testid="cellInnerDiv"]:has([data-testid="UserCell"])', // 推荐关注
            '[data-testid="cellInnerDiv"]:has(a[href*="connect_people"])', // 显示更多
            '[data-testid="cellInnerDiv"]:has(a[href*="who_to_follow"])', // 推荐关注
            '[data-testid="cellInnerDiv"]:has(a[href*="trends"])', // 趋势推荐
            '[data-testid="cellInnerDiv"]:has(a[href*="i/connect_people"])' // 显示更多
        ];
        
        recommendSelectors.forEach(selector => {
            try {
                const elements = document.querySelectorAll(selector);
                elements.forEach(element => {
                    if (!hiddenRecommendElements.has(element)) {
                        // 检查是否包含推荐内容
                        const hasUserCell = element.querySelector('[data-testid="UserCell"]');
                        const hasConnectLink = element.querySelector('a[href*="connect_people"]');
                        const hasWhoToFollow = element.querySelector('a[href*="who_to_follow"]');
                        const hasTrends = element.querySelector('a[href*="trends"]');
                        
                        if (hasUserCell || hasConnectLink || hasWhoToFollow || hasTrends) {
                            element.style.display = 'none';
                            element.classList.add('hidden-recommend');
                            hiddenRecommendElements.add(element);
                        }
                    }
                });
            } catch (error) {
                // 忽略CSS选择器不支持的错误
                console.warn('Selector error:', error);
            }
        });
        
        // 使用更通用的方法查找推荐内容
        const allCells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
        allCells.forEach(cell => {
            if (!hiddenRecommendElements.has(cell)) {
                const userCell = cell.querySelector('[data-testid="UserCell"]');
                const connectLink = cell.querySelector('a[href*="connect_people"]');
                const whoToFollow = cell.querySelector('a[href*="who_to_follow"]');
                const trends = cell.querySelector('a[href*="trends"]');
                const showMore = cell.querySelector('a[href*="i/connect_people"]');
                
                if (userCell || connectLink || whoToFollow || trends || showMore) {
                    cell.style.display = 'none';
                    cell.classList.add('hidden-recommend');
                    hiddenRecommendElements.add(cell);
                }
            }
        });
        
        // 启动监控新推荐内容的出现
        startRecommendHideObserver();
    }
    
    function restoreAllRecommends() {
        // 恢复所有隐藏的推荐内容
        hiddenRecommendElements.forEach(element => {
            if (element.parentNode) {
                element.style.display = '';
                element.classList.remove('hidden-recommend');
            }
        });
        hiddenRecommendElements.clear();
        
        // 停止监控
        stopRecommendHideObserver();
    }
    
    function startRecommendHideObserver() {
        // 避免重复创建监控器
        if (window.recommendHideObserver) {
            return;
        }
        
        window.recommendHideObserver = new MutationObserver(() => {
            if (recommendHideMode) {
                setTimeout(() => {
                    const newCells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
                    newCells.forEach(cell => {
                        if (!hiddenRecommendElements.has(cell)) {
                            const userCell = cell.querySelector('[data-testid="UserCell"]');
                            const connectLink = cell.querySelector('a[href*="connect_people"]');
                            const whoToFollow = cell.querySelector('a[href*="who_to_follow"]');
                            const trends = cell.querySelector('a[href*="trends"]');
                            const showMore = cell.querySelector('a[href*="i/connect_people"]');
                            
                            if (userCell || connectLink || whoToFollow || trends || showMore) {
                                cell.style.display = 'none';
                                cell.classList.add('hidden-recommend');
                                hiddenRecommendElements.add(cell);
                            }
                        }
                    });
                }, 100);
            }
        });
        
        if (document.body) {
            window.recommendHideObserver.observe(document.body, {
                childList: true,
                subtree: true
            });
        }
    }
    
    function stopRecommendHideObserver() {
        if (window.recommendHideObserver) {
            window.recommendHideObserver.disconnect();
            window.recommendHideObserver = null;
        }
    }
    
    function addDeleteButtons() {
        // 为所有推文添加删除按钮
        const tweets = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
        tweets.forEach(tweet => {
            if (!tweet.querySelector('.tweet-delete-btn') && !deletedElements.has(tweet)) {
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'tweet-delete-btn';
                deleteBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" width="16" height="16">
                        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/>
                    </svg>
                `;
                deleteBtn.title = '删除此推文';
                
                // 将按钮添加到推文的右上角
                tweet.style.position = 'relative';
                tweet.appendChild(deleteBtn);
            }
        });
        
        // 启动监控新推文的出现
        startDeleteButtonObserver();
    }
    
    function startDeleteButtonObserver() {
        // 避免重复创建监控器
        if (window.deleteButtonObserver) {
            return;
        }
        
        window.deleteButtonObserver = new MutationObserver(() => {
            if (deleteMode) {
                setTimeout(addDeleteButtons, 100);
            }
        });
        
        if (document.body) {
            window.deleteButtonObserver.observe(document.body, {
                childList: true,
                subtree: true
            });
        }
    }
    
    function stopDeleteButtonObserver() {
        if (window.deleteButtonObserver) {
            window.deleteButtonObserver.disconnect();
            window.deleteButtonObserver = null;
        }
    }
    
    function removeDeleteButtons() {
        // 移除所有删除按钮
        document.querySelectorAll('.tweet-delete-btn').forEach(btn => {
            btn.remove();
        });
        
        // 停止监控
        stopDeleteButtonObserver();
    }

    // === 自动滚动功能 ===

    function startAutoScroll() {
        // 清除之前的滚动计时器
        if (scrollInterval) {
            clearInterval(scrollInterval);
        }

        scrollInterval = setInterval(() => {
            // 根据设置的速度滚动
            window.scrollBy({
                top: scrollSpeed,
                left: 0,
                behavior: 'smooth'
            });
        }, 50); // 每50毫秒滚动一次，实现平滑缓慢滚动
    }

    function stopAutoScroll() {
        if (scrollInterval) {
            clearInterval(scrollInterval);
            scrollInterval = null;
        }
    }

    function setScrollSpeed(speed) {
        scrollSpeed = speed;
        document.getElementById('speed-display').textContent = `${speed}px/次`;
        document.getElementById('speed-slider').value = speed;

        // 如果正在滚动，重启以应用新速度
        if (autoScrollMode) {
            stopAutoScroll();
            startAutoScroll();
        }
    }

    function updateStatus() {
        // 更新视频状态
        const videos = document.querySelectorAll('video');
        document.getElementById('video-count').textContent = videos.length;

        // 更新循环状态
        document.getElementById('loop-status').textContent = loopMode ? '开启' : '关闭';

        // 更新静音状态
        document.getElementById('mute-status').textContent = muteMode ? '开启' : '关闭';

        // 更新滚动状态
        document.getElementById('scroll-status').textContent = autoScrollMode ? '开启' : '关闭';

        // 更新删除计数
        document.getElementById('deleted-count').textContent = deletedElements.size;

        // 更新隐藏文本计数
        document.getElementById('hidden-text-count').textContent = hiddenTextElements.size;

        // 更新隐藏推荐内容计数
        document.getElementById('hidden-recommend-count').textContent = hiddenRecommendElements.size;
    }
    
    function showDeleteHint() {
        // 检查是否已存在提示
        if (document.getElementById('delete-hint')) {
            return;
        }
        
        const hint = document.createElement('div');
        hint.id = 'delete-hint';
        hint.innerHTML = `
            <div class="hint-content">
                <span class="hint-icon">👆</span>
                <span class="hint-text">点击红色按钮删除推文</span>
                <button class="hint-close" id="hint-close">×</button>
            </div>
        `;
        document.body.appendChild(hint);
        
        // 绑定关闭事件
        document.getElementById('hint-close').addEventListener('click', () => {
            hint.remove();
        });
        
        setTimeout(() => {
            hint.classList.add('show');
        }, 100);
        
        // 5秒后自动关闭
        setTimeout(() => {
            if (hint.parentNode) {
                hint.classList.remove('show');
                setTimeout(() => {
                    if (hint.parentNode) {
                        hint.remove();
                    }
                }, 300);
            }
        }, 5000);
    }
    
    function hideDeleteHint() {
        const hint = document.getElementById('delete-hint');
        if (hint) {
            hint.remove();
        }
    }
    
    function showDeleteSuccess() {
        const success = document.createElement('div');
        success.className = 'delete-success';
        success.innerHTML = '✓ 推文已删除';
        document.body.appendChild(success);
        
        setTimeout(() => success.classList.add('show'), 100);
        setTimeout(() => {
            success.classList.remove('show');
            setTimeout(() => success.remove(), 300);
        }, 2000);
    }
    
    function showTextHideHint() {
        // 检查是否已存在提示
        if (document.getElementById('text-hide-hint')) {
            return;
        }
        
        const hint = document.createElement('div');
        hint.id = 'text-hide-hint';
        hint.innerHTML = `
            <div class="hint-content">
                <span class="hint-icon">👁️</span>
                <span class="hint-text">已隐藏包含媒体的推文文本</span>
                <button class="hint-close" id="text-hide-hint-close">×</button>
            </div>
        `;
        document.body.appendChild(hint);
        
        // 绑定关闭事件
        document.getElementById('text-hide-hint-close').addEventListener('click', () => {
            hint.remove();
        });
        
        setTimeout(() => {
            hint.classList.add('show');
        }, 100);
        
        // 5秒后自动关闭
        setTimeout(() => {
            if (hint.parentNode) {
                hint.classList.remove('show');
                setTimeout(() => {
                    if (hint.parentNode) {
                        hint.remove();
                    }
                }, 300);
            }
        }, 5000);
    }
    
    function hideTextHideHint() {
        const hint = document.getElementById('text-hide-hint');
        if (hint) {
            hint.remove();
        }
    }
    
    function showRecommendHideHint() {
        // 检查是否已存在提示
        if (document.getElementById('recommend-hide-hint')) {
            return;
        }
        
        const hint = document.createElement('div');
        hint.id = 'recommend-hide-hint';
        hint.innerHTML = `
            <div class="hint-content">
                <span class="hint-icon">🚫</span>
                <span class="hint-text">已隐藏推荐关注和"显示更多"内容</span>
                <button class="hint-close" id="recommend-hide-hint-close">×</button>
            </div>
        `;
        document.body.appendChild(hint);
        
        // 绑定关闭事件
        document.getElementById('recommend-hide-hint-close').addEventListener('click', () => {
            hint.remove();
        });
        
        setTimeout(() => {
            hint.classList.add('show');
        }, 100);
        
        // 5秒后自动关闭
        setTimeout(() => {
            if (hint.parentNode) {
                hint.classList.remove('show');
                setTimeout(() => {
                    if (hint.parentNode) {
                        hint.remove();
                    }
                }, 300);
            }
        }, 5000);
    }
    
    function hideRecommendHideHint() {
        const hint = document.getElementById('recommend-hide-hint');
        if (hint) {
            hint.remove();
        }
    }
    
    function addStyles() {
        const style = document.createElement('style');
        style.textContent = `
            /* 视频样式 */
            video[data-observed] {
                border: 1px solid rgba(0, 255, 0, 0.3) !important;
                transition: border-color 0.3s ease !important;
            }
            
            /* 控制面板样式 */
            #tweet-manager-panel {
                position: fixed;
                top: 20px;
                right: 20px;
                width: 280px;
                background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
                border: 1px solid #444;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
                z-index: 10000;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                backdrop-filter: blur(10px);
                transition: all 0.3s ease;
            }
            
            #tweet-manager-panel.collapsed {
                width: 40px;
                height: 40px;
                overflow: hidden;
                border-radius: 50%;
                background: rgba(26, 26, 26, 0.9);
                backdrop-filter: blur(10px);
            }
            
            .panel-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                border-bottom: 1px solid #444;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 12px 12px 0 0;
            }
            
            #tweet-manager-panel.collapsed .panel-header {
                padding: 0;
                border: none;
                background: transparent;
                border-radius: 50%;
                width: 40px;
                height: 40px;
                justify-content: center;
            }
            
            .panel-title {
                display: flex;
                align-items: center;
                gap: 8px;
                color: #fff;
                font-weight: 600;
                font-size: 14px;
            }
            
            #tweet-manager-panel.collapsed .panel-title {
                display: none;
            }
            
            .title-icon {
                font-size: 16px;
            }
            
            .panel-toggle {
                background: none;
                border: none;
                color: #ccc;
                font-size: 18px;
                cursor: pointer;
                padding: 4px 8px;
                border-radius: 4px;
                transition: all 0.2s ease;
                min-width: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            #tweet-manager-panel.collapsed .panel-toggle {
                color: #fff;
                font-size: 20px;
                padding: 8px;
                width: 40px;
                height: 40px;
                border-radius: 50%;
            }
            
            .panel-toggle:hover {
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
            }
            
            .panel-content {
                padding: 16px;
            }
            
            .feature-section {
                margin-bottom: 20px;
            }
            
            .feature-section:last-child {
                margin-bottom: 0;
            }
            
            .feature-section h3 {
                margin: 0 0 12px 0;
                color: #fff;
                font-size: 13px;
                font-weight: 600;
                opacity: 0.9;
            }
            
            .button-group {
                display: flex;
                gap: 8px;
                margin-bottom: 10px;
            }
            
            .control-btn {
                flex: 1;
                padding: 8px 12px;
                border: none;
                border-radius: 6px;
                background: linear-gradient(135deg, #3a3a3a 0%, #4a4a4a 100%);
                color: #fff;
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
            }
            
            .control-btn:hover {
                background: linear-gradient(135deg, #4a4a4a 0%, #5a5a5a 100%);
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            }
            
            .control-btn.active {
                background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
                box-shadow: 0 0 15px rgba(231, 76, 60, 0.3);
            }
            
            .control-btn.play-all {
                background: linear-gradient(135deg, #27ae60 0%, #2ecc71 100%);
            }
            
            .control-btn.pause-all {
                background: linear-gradient(135deg, #f39c12 0%, #e67e22 100%);
            }

            .control-btn.mute-all {
                background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
            }

            .control-btn.unmute-all {
                background: linear-gradient(135deg, #27ae60 0%, #2ecc71 100%);
            }

            .control-btn.loop-mode {
                background: linear-gradient(135deg, #9b59b6 0%, #8e44ad 100%);
            }

            .control-btn.mute-mode {
                background: linear-gradient(135deg, #34495e 0%, #2c3e50 100%);
            }

            .control-btn.mute-mode.active {
                background: linear-gradient(135deg, #f39c12 0%, #e67e22 100%);
                box-shadow: 0 0 15px rgba(243, 156, 18, 0.3);
            }

            .control-btn.loop-mode.active {
                background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
                box-shadow: 0 0 15px rgba(231, 76, 60, 0.3);
            }

            .control-btn.auto-scroll {
                background: linear-gradient(135deg, #34495e 0%, #2c3e50 100%);
            }

            .control-btn.auto-scroll.active {
                background: linear-gradient(135deg, #f39c12 0%, #e67e22 100%);
                box-shadow: 0 0 15px rgba(243, 156, 18, 0.3);
            }

            .scroll-controls {
                margin: 10px 0;
                padding: 12px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 8px;
                border: 1px solid #444;
            }

            .speed-label {
                display: block;
                color: #ccc;
                font-size: 12px;
                margin-bottom: 8px;
                font-weight: 500;
            }

            .speed-buttons {
                display: flex;
                gap: 6px;
                margin-bottom: 10px;
            }

            .speed-btn {
                flex: 1;
                padding: 6px 8px;
                border: none;
                border-radius: 4px;
                background: rgba(255, 255, 255, 0.1);
                color: #ccc;
                font-size: 11px;
                cursor: pointer;
                transition: all 0.2s ease;
            }

            .speed-btn:hover {
                background: rgba(255, 255, 255, 0.2);
                color: #fff;
            }

            .speed-btn.active {
                background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
                color: #fff;
                box-shadow: 0 0 8px rgba(52, 152, 219, 0.3);
            }

            .speed-slider {
                width: 100%;
                height: 4px;
                border-radius: 2px;
                background: #444;
                outline: none;
                margin: 8px 0;
                -webkit-appearance: none;
            }

            .speed-slider::-webkit-slider-thumb {
                -webkit-appearance: none;
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
                cursor: pointer;
                box-shadow: 0 0 6px rgba(52, 152, 219, 0.3);
            }

            .speed-slider::-moz-range-thumb {
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
                cursor: pointer;
                border: none;
                box-shadow: 0 0 6px rgba(52, 152, 219, 0.3);
            }

            .speed-display {
                display: block;
                text-align: center;
                color: #3498db;
                font-size: 11px;
                font-weight: 600;
                margin-top: 6px;
            }

            .control-btn.restore-all {
                background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
            }
            
            .status {
                font-size: 11px;
                color: #bbb;
                padding: 4px 8px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 4px;
                text-align: center;
            }
            
            .tips {
                font-size: 11px;
                color: #999;
            }
            
            .tip {
                margin-bottom: 4px;
                padding-left: 8px;
            }
            
            /* 删除模式样式 */
            .delete-mode-active article[data-testid="tweet"],
            .delete-mode-active article[role="article"] {
                transition: all 0.2s ease !important;
            }
            
            /* 删除按钮样式 */
            .tweet-delete-btn {
                position: absolute !important;
                top: 12px !important;
                right: 12px !important;
                width: 32px !important;
                height: 32px !important;
                border: none !important;
                border-radius: 50% !important;
                background: rgba(231, 76, 60, 0.9) !important;
                color: white !important;
                cursor: pointer !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                z-index: 1000 !important;
                opacity: 0.8 !important;
                transition: all 0.2s ease !important;
                box-shadow: 0 2px 8px rgba(231, 76, 60, 0.3) !important;
            }
            
            .tweet-delete-btn:hover {
                opacity: 1 !important;
                transform: scale(1.1) !important;
                box-shadow: 0 4px 12px rgba(231, 76, 60, 0.5) !important;
            }
            
            .tweet-delete-btn:active {
                transform: scale(0.95) !important;
            }
            
            .tweet-delete-btn svg {
                pointer-events: none !important;
            }
            
            /* 删除成功提示 */
            .delete-success {
                position: fixed;
                bottom: 30px;
                right: 30px;
                background: linear-gradient(135deg, #27ae60 0%, #2ecc71 100%);
                color: #fff;
                padding: 12px 20px;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 500;
                z-index: 10001;
                opacity: 0;
                transform: translateY(20px);
                transition: all 0.3s ease;
                box-shadow: 0 4px 20px rgba(39, 174, 96, 0.3);
            }
            
            .delete-success.show {
                opacity: 1;
                transform: translateY(0);
            }
            
            /* 已删除的推文 */
            .deleted-tweet {
                opacity: 0.3 !important;
                pointer-events: none !important;
            }
            
            /* 删除提示 */
            #delete-hint {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%) scale(0.8);
                background: rgba(0, 0, 0, 0.9);
                padding: 20px 30px;
                border-radius: 12px;
                color: #fff;
                z-index: 10001;
                opacity: 0;
                transition: all 0.3s ease;
                backdrop-filter: blur(10px);
                border: 1px solid #444;
            }
            
            #delete-hint.show {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
            
            .hint-content {
                display: flex;
                align-items: center;
                gap: 12px;
                font-size: 16px;
            }
            
            .hint-icon {
                font-size: 24px;
            }
            
            .hint-close {
                background: none;
                border: none;
                color: #ccc;
                font-size: 20px;
                cursor: pointer;
                padding: 0 8px;
                margin-left: 12px;
            }
            
            .hint-close:hover {
                color: #fff;
            }
            
            /* 文本隐藏模式样式 */
            .text-hide-mode-active [data-testid="tweetText"].hidden-text {
                display: none !important;
            }
            
            .control-btn.text-hide-mode {
                background: linear-gradient(135deg, #9b59b6 0%, #8e44ad 100%);
            }
            
            .control-btn.text-hide-mode.active {
                background: linear-gradient(135deg, #e67e22 0%, #d35400 100%);
                box-shadow: 0 0 15px rgba(230, 126, 34, 0.3);
            }
            
            .control-btn.restore-text {
                background: linear-gradient(135deg, #1abc9c 0%, #16a085 100%);
            }
            
            .control-btn.recommend-hide-mode {
                background: linear-gradient(135deg, #e67e22 0%, #d35400 100%);
            }
            
            .control-btn.recommend-hide-mode.active {
                background: linear-gradient(135deg, #27ae60 0%, #2ecc71 100%);
                box-shadow: 0 0 15px rgba(39, 174, 96, 0.3);
            }
            
            .control-btn.restore-recommend {
                background: linear-gradient(135deg, #34495e 0%, #2c3e50 100%);
            }
        `;
        document.head.appendChild(style);
    }
    
    // 初始化所有功能
    function initialize() {
        // 视频播放功能
        interceptVideoTimers();
        interceptPauseCalls();
        enhancePlayMethod();
        setupUserInteraction();
        setupAutoPlay();
        setupMonitoring();
        setupVisibilityHandling();
        blockOtherControls();
        
        // UI界面
        addStyles();
        
        // 等待页面加载完成后创建UI
        setTimeout(() => {
            createUI();
        }, 1000);
    }
    
    // 简化的调试接口
    window.multiVideoPlayer = {
        version: '5.8',
        playAll: () => {
            document.querySelectorAll('video').forEach(video => {
                userPausedVideos.delete(video);
                if (video.paused) {
                    video.play();
                }
            });
        },
        pauseAll: () => {
            document.querySelectorAll('video').forEach(video => {
                userPausedVideos.add(video);
                allowedPauses.add(video);
                video.pause();
            });
        },
        toggleLoop: () => {
            document.getElementById('loop-mode').click();
        },
        setLoop: (enabled) => {
            if (loopMode !== enabled) {
                document.getElementById('loop-mode').click();
            }
        },
        toggleAutoScroll: () => {
            document.getElementById('auto-scroll').click();
        },
        setAutoScroll: (enabled) => {
            if (autoScrollMode !== enabled) {
                document.getElementById('auto-scroll').click();
            }
        },
        setScrollSpeed: (speed) => {
            setScrollSpeed(speed);
        },
        getScrollSpeed: () => {
            return scrollSpeed;
        },
        muteAll: () => {
            document.getElementById('mute-all').click();
        },
        unmuteAll: () => {
            document.getElementById('unmute-all').click();
        },
        toggleMute: () => {
            document.getElementById('mute-mode').click();
        },
        setMute: (enabled) => {
            if (muteMode !== enabled) {
                document.getElementById('mute-mode').click();
            }
        },
        stats: () => {
            const videos = document.querySelectorAll('video');
            const playing = Array.from(videos).filter(v => !v.paused).length;
            const looping = Array.from(videos).filter(v => v.loop).length;
            const muted = Array.from(videos).filter(v => v.muted).length;
            const paused = videos.length - playing;
            return {
                total: videos.length,
                playing,
                paused,
                looping,
                muted,
                loopMode: loopMode,
                muteMode: muteMode,
                autoScrollMode: autoScrollMode,
                scrollSpeed: scrollSpeed,
                deleted: deletedElements.size,
                hiddenText: hiddenTextElements.size,
                hiddenRecommend: hiddenRecommendElements.size
            };
        },
        toggleDeleteMode: () => {
            document.getElementById('delete-mode').click();
        },
        restoreAll: () => {
            document.getElementById('restore-all').click();
        },
        toggleTextHideMode: () => {
            document.getElementById('text-hide-mode').click();
        },
        restoreAllTexts: () => {
            document.getElementById('restore-text').click();
        },
        toggleRecommendHideMode: () => {
            document.getElementById('recommend-hide-mode').click();
        },
        restoreAllRecommends: () => {
            document.getElementById('restore-recommend').click();
        }
    };
    
    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        setTimeout(initialize, 0);
    }
})();
