# -*- coding: utf-8 -*-
"""系统托盘（纯 ctypes 调用 Win32，无第三方依赖）。

启动后自动隐藏控制台窗口，只在任务栏托盘留一个自绘图标；右键菜单提供
「打开管理界面 / 查看日志 / 退出」。仅 Windows 有效，其它平台静默跳过。
Loshop & Cpt"""
import ctypes
import os
import threading
from ctypes import wintypes

from novacore.paths import LOG_DIR, slog

IS_WINDOWS = os.name == "nt"

# ----------------------------- Win32 常量 -----------------------------
WM_USER = 0x0400
WM_TRAYICON = WM_USER + 20
WM_COMMAND = 0x0111
WM_DESTROY = 0x0002
WM_RBUTTONUP = 0x0205
WM_LBUTTONUP = 0x0202
NIM_ADD, NIM_MODIFY, NIM_DELETE = 0, 1, 2
NIF_MESSAGE, NIF_ICON, NIF_TIP = 0x01, 0x02, 0x04
MF_STRING, MF_SEPARATOR = 0x0000, 0x0800
TPM_RETURNCMD, TPM_RIGHTBUTTON = 0x0100, 0x0002
SW_HIDE = 0
SW_SHOW = 5
ID_OPEN_ADMIN, ID_VIEW_LOG, ID_EXIT = 1001, 1002, 1003
IDI_APPLICATION = 32512
TRAY_TIP = "Tzy OS stealth 注入服务运行中"
ICON_SIZE = 32
# 图标配色（BGRA）：深蓝圆角底 + 白色 T
BG = (0xEB, 0x6F, 0x1F, 255)   # #1F6FEB
FG = (0xFF, 0xFF, 0xFF, 255)   # 白

if IS_WINDOWS:
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    kernel32 = ctypes.windll.kernel32
    shell32 = ctypes.windll.shell32
    LRESULT = ctypes.c_ssize_t
    WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT,
                                 wintypes.WPARAM, wintypes.LPARAM)

    class WNDCLASSW(ctypes.Structure):
        _fields_ = [
            ("style", wintypes.UINT),
            ("lpfnWndProc", WNDPROC),
            ("cbClsExtra", ctypes.c_int),
            ("cbWndExtra", ctypes.c_int),
            ("hInstance", wintypes.HINSTANCE),
            ("hIcon", wintypes.HICON),
            ("hCursor", wintypes.HANDLE),
            ("hbrBackground", wintypes.HBRUSH),
            ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR),
        ]

    class NOTIFYICONDATAW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("hWnd", wintypes.HWND),
            ("uID", wintypes.UINT),
            ("uFlags", wintypes.UINT),
            ("uCallbackMessage", wintypes.UINT),
            ("hIcon", wintypes.HICON),
            ("szTip", wintypes.WCHAR * 128),
            ("dwState", wintypes.DWORD),
            ("dwStateMask", wintypes.DWORD),
            ("szInfo", wintypes.WCHAR * 256),
            ("uTimeout", wintypes.UINT),
            ("szInfoTitle", wintypes.WCHAR * 64),
            ("dwInfoFlags", wintypes.DWORD),
        ]

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
            ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
            ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [("bmiHeader", BITMAPINFOHEADER),
                    ("bmiColors", wintypes.DWORD * 3)]

    class ICONINFO(ctypes.Structure):
        _fields_ = [
            ("fIcon", wintypes.BOOL), ("xHotspot", wintypes.DWORD),
            ("yHotspot", wintypes.DWORD), ("hbmMask", wintypes.HBITMAP),
            ("hbmColor", wintypes.HBITMAP),
        ]

    # 显式声明原型：句柄/指针返回值若按默认 c_int 处理，64 位下会被截断。
    user32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
    user32.RegisterClassW.restype = wintypes.ATOM
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT,
                                      wintypes.WPARAM, wintypes.LPARAM]
    user32.DefWindowProcW.restype = LRESULT
    user32.CreatePopupMenu.restype = wintypes.HMENU
    user32.AppendMenuW.argtypes = [wintypes.HMENU, wintypes.UINT,
                                   ctypes.c_size_t, wintypes.LPCWSTR]
    user32.AppendMenuW.restype = wintypes.BOOL
    user32.TrackPopupMenu.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_int,
                                      ctypes.c_int, ctypes.c_int, wintypes.HWND,
                                      wintypes.LPVOID]
    user32.TrackPopupMenu.restype = wintypes.UINT
    user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    user32.GetCursorPos.restype = wintypes.BOOL
    user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND,
                                   wintypes.UINT, wintypes.UINT]
    user32.GetMessageW.restype = ctypes.c_int
    user32.LoadIconW.argtypes = [wintypes.HINSTANCE, ctypes.c_void_p]
    user32.LoadIconW.restype = wintypes.HICON
    user32.CreateIconIndirect.argtypes = [ctypes.POINTER(ICONINFO)]
    user32.CreateIconIndirect.restype = wintypes.HICON
    user32.GetDC.argtypes = [wintypes.HWND]
    user32.GetDC.restype = wintypes.HDC
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    user32.ReleaseDC.restype = ctypes.c_int
    gdi32.CreateDIBSection.argtypes = [
        wintypes.HDC, ctypes.POINTER(BITMAPINFO), wintypes.UINT,
        ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
    gdi32.CreateDIBSection.restype = wintypes.HBITMAP
    gdi32.CreateBitmap.argtypes = [ctypes.c_int, ctypes.c_int, wintypes.UINT,
                                   wintypes.UINT, ctypes.c_void_p]
    gdi32.CreateBitmap.restype = wintypes.HBITMAP
    gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi32.DeleteObject.restype = wintypes.BOOL
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.ShowWindow.restype = wintypes.BOOL
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT,
                                    wintypes.WPARAM, wintypes.LPARAM]
    user32.PostMessageW.restype = wintypes.BOOL
    user32.PostQuitMessage.argtypes = [ctypes.c_int]
    user32.PostQuitMessage.restype = None
    user32.DestroyMenu.argtypes = [wintypes.HMENU]
    user32.DestroyMenu.restype = wintypes.BOOL
    user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.TranslateMessage.restype = wintypes.BOOL
    user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.DispatchMessageW.restype = LRESULT
    kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel32.GetModuleHandleW.restype = wintypes.HINSTANCE
    kernel32.GetConsoleWindow.restype = wintypes.HWND
    shell32.Shell_NotifyIconW.argtypes = [wintypes.DWORD,
                                          ctypes.POINTER(NOTIFYICONDATAW)]
    shell32.Shell_NotifyIconW.restype = wintypes.BOOL


def available():
    """托盘仅在 Windows 上可用。"""
    return IS_WINDOWS


def _in_round_rect(x, y, w, h, r):
    """圆角矩形内判定（四角按圆处理，其余为直边）。"""
    if x < r and y < r:
        return (r - x) ** 2 + (r - y) ** 2 <= r * r
    if x >= w - r and y < r:
        return (x - (w - 1 - r)) ** 2 + (r - y) ** 2 <= r * r
    if x < r and y >= h - r:
        return (r - x) ** 2 + (y - (h - 1 - r)) ** 2 <= r * r
    if x >= w - r and y >= h - r:
        return (x - (w - 1 - r)) ** 2 + (y - (h - 1 - r)) ** 2 <= r * r
    return True


def _make_icon(size=ICON_SIZE):
    """自绘图标：深蓝圆角方块 + 白色 T。失败时回退系统默认图标。"""
    try:
        hdc = user32.GetDC(None)
        bmi = BITMAPINFO()
        hdr = bmi.bmiHeader
        hdr.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        hdr.biWidth = size
        hdr.biHeight = -size          # 负高度 = 自上而下
        hdr.biPlanes = 1
        hdr.biBitCount = 32
        hdr.biCompression = 0         # BI_RGB
        bits = ctypes.c_void_p()
        hbm_color = gdi32.CreateDIBSection(hdc, ctypes.byref(bmi), 0,
                                           ctypes.byref(bits), None, 0)
        user32.ReleaseDC(None, hdc)
        if not hbm_color or not bits.value:
            raise OSError("CreateDIBSection failed")

        buf = (ctypes.c_ubyte * (size * size * 4)).from_address(bits.value)
        # T 形：横杠 x[8,23] y[9,12]；竖杠 x[13,18] y[12,23]
        for y in range(size):
            for x in range(size):
                if not _in_round_rect(x, y, size, size, 6):
                    continue
                is_t = (8 <= x <= 23 and 9 <= y <= 12) or \
                       (13 <= x <= 18 and 12 <= y <= 23)
                r, g, b, a = FG if is_t else BG
                i = (y * size + x) * 4
                buf[i], buf[i + 1], buf[i + 2], buf[i + 3] = b, g, r, a

        mask_bytes = (ctypes.c_ubyte * (size * size // 8))()  # 全 0：不透明位交给 alpha
        hbm_mask = gdi32.CreateBitmap(size, size, 1, 1, ctypes.byref(mask_bytes))
        ii = ICONINFO(True, 0, 0, hbm_mask, hbm_color)
        hicon = user32.CreateIconIndirect(ctypes.byref(ii))
        gdi32.DeleteObject(hbm_color)
        if hbm_mask:
            gdi32.DeleteObject(hbm_mask)
        if hicon:
            return hicon
    except Exception as e:
        slog("warn", "tray", "自绘图标失败，改用系统默认图标：%s" % e)
    return user32.LoadIconW(None, ctypes.c_void_p(IDI_APPLICATION))


def hide_console():
    """隐藏控制台窗口（仅影响本进程的控制台）。"""
    try:
        hwnd = kernel32.GetConsoleWindow()
        if hwnd:
            user32.ShowWindow(hwnd, SW_HIDE)
    except Exception:
        pass


def show_console():
    """恢复控制台窗口：退出时让 start.bat 的 pause 可见，避免隐藏窗口卡住进程。"""
    try:
        hwnd = kernel32.GetConsoleWindow()
        if hwnd:
            user32.ShowWindow(hwnd, SW_SHOW)
    except Exception:
        pass


class _Tray(object):
    def __init__(self, admin_port, on_exit):
        self.admin_port = int(admin_port)
        self.on_exit = on_exit
        self.hwnd = None
        self.hicon = None
        self._wndproc = None       # 保持引用，否则回调被 GC 回收
        self._ready = threading.Event()
        self._thread = None

    # ---------------- 生命周期 ----------------
    def start(self):
        self._thread = threading.Thread(target=self._run, name="nova-tray",
                                        daemon=True)
        self._thread.start()
        self._ready.wait(4)
        return self.hwnd is not None

    def _run(self):
        try:
            self._create_window()
            self._add_icon()
            self._ready.set()
            hide_console()
            slog("info", "tray", "托盘图标已就绪，控制台已隐藏")
        except Exception as e:
            slog("warn", "tray", "托盘初始化失败：%s" % e)
            self._ready.set()
            return
        self._message_loop()

    def stop(self):
        if self.hwnd:
            user32.PostMessageW(self.hwnd, WM_DESTROY, 0, 0)
        # 退出前恢复控制台：start.bat 末尾的 pause 需要可见窗口，否则进程会
        # 带着隐藏的窗口一直卡在 pause 上，用户以为没退干净。
        show_console()

    # ---------------- 窗口与图标 ----------------
    def _create_window(self):
        hinst = kernel32.GetModuleHandleW(None)
        self._wndproc = WNDPROC(self._on_message)
        wc = WNDCLASSW()
        wc.lpfnWndProc = self._wndproc
        wc.hInstance = hinst
        wc.lpszClassName = "NovaTrayWnd"
        user32.RegisterClassW(ctypes.byref(wc))  # 已注册过会返回 0，忽略
        # 不显示（无 WS_VISIBLE）的顶层窗口，仅用于接收托盘回调消息
        self.hwnd = user32.CreateWindowExW(
            0, "NovaTrayWnd", "NovaTray", 0, 0, 0, 0, 0,
            None, None, hinst, None)
        if not self.hwnd:
            raise ctypes.WinError()

    def _add_icon(self):
        self.hicon = _make_icon()
        nid = NOTIFYICONDATAW()
        nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
        nid.hWnd = self.hwnd
        nid.uID = 1
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
        nid.uCallbackMessage = WM_TRAYICON
        nid.hIcon = self.hicon
        nid.szTip = TRAY_TIP
        if not shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(nid)):
            raise ctypes.WinError()

    def _remove_icon(self):
        try:
            nid = NOTIFYICONDATAW()
            nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
            nid.hWnd = self.hwnd
            nid.uID = 1
            shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(nid))
        except Exception:
            pass

    # ---------------- 消息处理 ----------------
    def _on_message(self, hwnd, msg, wparam, lparam):
        if msg == WM_TRAYICON:
            # 仅右键菜单：左键不做任何事
            if lparam == WM_RBUTTONUP:
                self._popup_menu()
            return 0
        if msg == WM_COMMAND:
            self._on_command(wparam & 0xFFFF)
            return 0
        if msg == WM_DESTROY:
            self._remove_icon()
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _popup_menu(self):
        menu = user32.CreatePopupMenu()
        user32.AppendMenuW(menu, MF_STRING, ID_OPEN_ADMIN, "打开管理界面")
        user32.AppendMenuW(menu, MF_STRING, ID_VIEW_LOG, "查看日志")
        user32.AppendMenuW(menu, MF_SEPARATOR, 0, None)
        user32.AppendMenuW(menu, MF_STRING, ID_EXIT, "退出")
        pt = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        # 先置前台，菜单才能正常响应点击/失焦消失
        user32.SetForegroundWindow(self.hwnd)
        cmd = user32.TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON,
                                    pt.x, pt.y, 0, self.hwnd, None)
        user32.PostMessageW(self.hwnd, 0, 0, 0)  # WM_NULL
        user32.DestroyMenu(menu)
        if cmd:
            self._on_command(cmd)

    def _on_command(self, cmd):
        if cmd == ID_OPEN_ADMIN:
            self._open("http://127.0.0.1:%d/" % self.admin_port)
        elif cmd == ID_VIEW_LOG:
            self._open_log()
        elif cmd == ID_EXIT:
            self._quit()

    def _open(self, target):
        try:
            os.startfile(target)
        except Exception as e:
            slog("warn", "tray", "打开 %s 失败：%s" % (target, e))

    def _open_log(self):
        """打开 logs 目录（默认编辑器关联 .log 不可靠，直接开目录最稳）。"""
        self._open(LOG_DIR if os.path.isdir(LOG_DIR) else os.path.dirname(LOG_DIR))

    def _quit(self):
        if self.on_exit:
            try:
                self.on_exit()
            except Exception:
                pass
        self.stop()

    def _message_loop(self):
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))


def start(admin_port, on_exit):
    """启动托盘；成功返回句柄对象，失败/非 Windows 返回 None。"""
    if not IS_WINDOWS:
        return None
    tray = _Tray(admin_port, on_exit)
    try:
        return tray if tray.start() else None
    except Exception as e:
        slog("warn", "tray", "托盘启动异常：%s" % e)
        return None