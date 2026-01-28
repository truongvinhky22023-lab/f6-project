const express = require("express");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const methodOverride = require('method-override');
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const XLSX = require('xlsx');
  
const app = express();
const PORT = 3000;

// ====================== CẤU HÌNH CƠ BẢN ======================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/public'));
app.use(express.static(path.join(__dirname, 'src/public')));
app.use(methodOverride('_method'));

app.use(session({
    secret: "lssd_secret_2026",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const DB_FILE = "./database.json";

// ====================== CẤU HÌNH MULTER (AVATAR) ======================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, "src/public/storage/avatars");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, uuidv4() + path.extname(file.originalname));
    }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } });


// ====================== DATA & HELPER ======================

const SALARY_RATES = {
    "Giám đốc": 50000, "Phó Giám đốc": 50000, "Trợ lý": 25000,
    "Thư ký": 21500, "Trưởng phòng": 18000, "Phó phòng": 14500,
    "Cảnh sát viên": 10714, "Sĩ quan dự bị": 10714
};
const AVAILABLE_RANKS = ["Hạ sĩ", "Trung sĩ", "Thượng sĩ", "Thiếu úy", "Trung úy", "Thượng úy", "Đại úy", "Thiếu tá", "Trung tá", "Thượng tá", "Đại tá"];

function loadDB() {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], trash: [], logs: [] }, null, 2));
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (!data.trash) data.trash = [];
    if (!data.logs) data.logs = [];
    return data;
}

function saveDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function addLog(actor, action, target, detail) {
    const db = loadDB();
    db.logs.unshift({
        time: new Date().toLocaleString('vi-VN'),
        actor, action, target, detail
    });
    saveDB(db);
}

// ====================== MIDDLEWARE ======================
// Route khôi phục nhân sự
app.post('/admin/restore/:targetName', (req, res) => {
    const targetName = req.params.targetName;
    
    // 1. Tìm nhân sự trong thùng rác (db.trash)
    const userIndex = db.trash.findIndex(u => u.displayName === targetName);
    
    if (userIndex !== -1) {
        const restoredUser = db.trash.splice(userIndex, 1)[0]; // Lấy ra khỏi thùng rác
        db.users.push(restoredUser); // Đưa trở lại danh sách nhân sự
        
        // 2. Ghi log hành động khôi phục
        db.logs.push({
            actor: req.session.user.username, // Hoặc người đang đăng nhập
            action: "KHÔI PHỤC",
            target: targetName,
            timestamp: new Date().toLocaleString('vi-VN'),
            details: "Đã đưa sĩ quan trở lại từ thùng rác"
        });

        res.json({ success: true, message: "Khôi phục thành công!" });
    } else {
        res.status(404).json({ success: false, message: "Không tìm thấy nhân sự trong thùng rác" });
    }
});
const requireAuth = (req, res, next) => req.session.user ? next() : res.redirect("/index.html");
const requireAdmin = (req, res, next) => (req.session.user && req.session.user.role === 'admin') ? next() : res.status(403).send("Forbidden");

// ====================== ROUTES CHÍNH ======================


app.get('/payroll', (req, res) => {
    try {
        const db = loadDB(); // Hàm đọc database.json của bạn
        
        // 1. Lấy tháng hiện tại để lọc dữ liệu
        const currentMonth = new Date().getMonth() + 1;

        // 2. Chuẩn bị dữ liệu bảng lương từ danh sách nhân viên
        const payrollData = db.users.map(user => {
            // Lọc lịch sử chấm công của user này trong tháng hiện tại
            const userAttendance = (db.attendance || []).filter(record => 
                record.username === user.username && 
                new Date(record.checkIn).getMonth() + 1 === currentMonth
            );

            // Tính tổng số phút làm việc
            const totalMinutes = userAttendance.reduce((sum, record) => sum + (record.duration || 0), 0);
            
            // Lấy hệ số lương dựa trên Quân hàm/Chức vụ
            const config = (db.salary_configs || []).find(c => c.rank === user.rank) || { pay: 0 };

            return {
                fullName: user.fullName,
                rank: user.rank,
                position: user.position || "Sĩ quan",
                totalMinutes: totalMinutes,
                payRate: config.pay, // Ví dụ: 25000
                userId: user.id
            };
        });

    } catch (error) {
        console.error("Lỗi Payroll:", error);
        res.status(500).send("Lỗi xử lý bảng lương");
    }
});

// API cập nhật hệ số lương
app.post('/admin/update-salary-configs', requireAdmin, (req, res) => {
    const db = loadDB();
    const { role, newPay, newHours } = req.body;

    const config = db.salary_configs.find(s => s.role === role);
    if (config) {
        config.pay = parseInt(newPay);
        config.hours = parseFloat(newHours);
        config.updatedBy = req.session.user.displayName;
        config.updatedAt = new Date().toLocaleString('vi-VN');

        saveDB(db);
        
        // Ghi log hành động
        writeLog(req.session.user.displayName, "cập nhật", `Hệ số lương ${role}`, `Lương mới: ${newPay}$`);

        res.json({ success: true, message: "Cập nhật thành công!" });
    } else {
        res.status(404).json({ success: false, message: "Không tìm thấy chức vụ!" });
    }
});
// Hàm tiện ích để ghi log (Copy cái này dùng chung)
function writeLog(actor, action, target, details = "") {
    const newLog = {
        actor: actor,
        action: action, // Đảm bảo chứa chữ "XÓA", "Tạo", "cập nhật" như giao diện cần
        target: target,
        timestamp: new Date().toLocaleString('vi-VN', { 
            hour: '2-digit', minute: '2-digit', 
            day: '2-digit', month: '2-digit', year: 'numeric' 
        }),
        details: details
    };

    if (!db.logs) db.logs = [];
    
    // Thêm log mới vào đầu mảng
    db.logs.unshift(newLog); 

    // --- TỰ ĐỘNG XÓA LOG CŨ ---
    // Chỉ giữ lại 50 log gần nhất để nhẹ database
    if (db.logs.length > 50) {
        db.logs = db.logs.slice(0, 50);
    }
    
    // Lưu database (Ví dụ dùng fs.writeFileSync nếu bạn dùng file json)
    // saveDatabase(); 
}
// Route Xử lý xóa vĩnh viễn nhiều người cùng lúc từ thùng rác
app.post('/admin/trash/bulk-delete', requireAdmin, (req, res) => {
    try {
        const db = loadDB();
        const { userIds } = req.body; // userIds là mảng các ID gửi từ Checkbox

        if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
            return res.redirect('/admin?error=none_selected');
        }

        const actor = req.session.user.displayName || req.session.user.username;

        // Lọc bỏ các user có ID nằm trong danh sách chọn ra khỏi thùng rác
        db.trash = db.trash.filter(user => {
            if (userIds.includes(user.id.toString())) {
                addLog(actor, "XÓA VĨNH VIỄN (HÀNG LOẠT)", user.displayName, "Dữ liệu đã bị dọn dẹp sạch");
                return false; // Loại bỏ khỏi mảng trash
            }
            return true; // Giữ lại
        });

        saveDB(db);
        res.redirect('/admin?success=bulk_deleted');
    } catch (err) {
        console.error("Lỗi Bulk Delete:", err);
        res.redirect('/admin?error=server_error');
    }
});
// 1. TRANG ADMIN
app.get("/admin", requireAdmin, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.session.user.id) || req.session.user;
    res.render('admin', {
        db,
        displayName: user.displayName || "Quản trị viên",
        avatar: user.avatar,
        positions: Object.keys(SALARY_RATES),
        ranks: AVAILABLE_RANKS,
        success: req.query.success,
        error: req.query.error
    });
});

// 2. TẠO NHÂN SỰ MỚI (FIXED: Đã xử lý hết lỗi xoay màn hình)
app.post("/admin/create-user", requireAdmin, upload.single('avatar'), (req, res) => {
    try {
        const db = loadDB();
        const { username, password, displayName, rank, position } = req.body;

        if (!username || !password || !displayName || !rank) {
            return res.redirect("/admin?error=missing_fields");
        }

        if (db.users.some(u => u.username === username)) {
            return res.redirect("/admin?error=username_exists");
        }

        let avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=random&bold=true`;
        if (req.file) avatar = `/storage/avatars/${req.file.filename}`;

        const newUser = {
            id: Date.now(),
            username: username.trim(),
            password,
            role: "user",
            displayName: displayName.trim(),
            rank,
            position: position || "Không có",
            avatar,
            salaryRate: SALARY_RATES[rank] || 10714,
            careerTotal: 0,
            attendance: [],
            monthlyHistory: [],
            createdAt: new Date().toLocaleString('vi-VN')
        };

        db.users.push(newUser);
        saveDB(db);

        addLog(req.session.user.username, "TẠO NHÂN SỰ", displayName, `Chức vụ: ${rank}`);
        res.redirect("/admin?success=created"); // Trả về redirect ngay lập tức

    } catch (err) {
        console.error(err);
        res.redirect("/admin?error=server_error");
    }
});

// 3. XÓA TẠM THỜI (VÀO THÙNG RÁC)
app.post('/admin/delete/:id', requireAdmin, (req, res) => {
    const db = loadDB();
    const idx = db.users.findIndex(u => u.id == req.params.id);
    if (idx !== -1) {
        const user = db.users[idx];
        user.deletedAt = new Date().toLocaleString('vi-VN');
        db.trash.push(user);
        db.users.splice(idx, 1);
        saveDB(db);
        addLog(req.session.user.username, "XÓA TẠM THỜI", user.displayName, "Vào thùng rác");
    }
    res.redirect('/admin?success=deleted');
});

// 4. KHÔI PHỤC TỪ THÙNG RÁC
app.post('/admin/trash/restore/:id', requireAdmin, (req, res) => {
    const db = loadDB();
    const idx = db.trash.findIndex(u => u.id == req.params.id);
    if (idx !== -1) {
        const user = db.trash[idx];
        delete user.deletedAt;
        db.users.push(user);
        db.trash.splice(idx, 1);
        saveDB(db);
        res.redirect('/admin?success=restored');
    }
});

// 5. ĐĂNG NHẬP
app.post("/login", (req, res) => {
    const { username, password } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.username === username && u.password === password);
    if (!user) return res.redirect("/index.html?error=invalid");

    req.session.user = user;
    res.redirect("/home");
});

// Đăng xuất
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/index.html"));
});

// Trang chủ
app.get("/home", requireAuth, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.session.user.id);
  if (!user) return res.redirect("/index.html");

  const page = parseInt(req.query.page) || 1;
  const perPage = 10;
  const totalUsers = db.users.length;
  const totalPages = Math.ceil(totalUsers / perPage);
  const start = (page - 1) * perPage;
  const usersPage = db.users.slice(start, start + perPage);

  res.render('home', {
    displayName: user.displayName,
    position: user.position,
    rank: user.rank,
    avatar: user.avatar,
    role: user.role,
    users: usersPage,
    currentPage: page,
    totalPages: totalPages,
    totalMembers: totalUsers,
    highLevelMembers: db.users.filter(u => u.role === 'admin').length
  });
});

// Attendance
app.get("/attendance", requireAuth, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.session.user.id);
  if (!user) return res.redirect("/index.html");

  const now = new Date();
  const today = now.toLocaleDateString('en-US');
  const currentMonthStr = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

  user.attendance = user.attendance || [];
  user.monthlyHistory = user.monthlyHistory || [];
  user.careerTotal = Number(user.careerTotal) || 0;
  user.salaryRate = Number(user.salaryRate) || 10714;

  const todayRecords = user.attendance.filter(a => a.date === today);
  const completedHoursToday = todayRecords
    .filter(r => r.offTime && Number(r.hours || 0) > 0)
    .reduce((sum, r) => sum + Number(r.hours || 0), 0);

  const isOnDuty = todayRecords.some(r => !r.offTime);
  const remainingHoursToday = Math.max(0, 4 - completedHoursToday);

  const monthEntry = user.monthlyHistory.find(h => h.month === currentMonthStr);
  const monthlySalary = monthEntry ? (Number(monthEntry.salary) || 0) : 0;

  const groupedAttendance = {};
  user.attendance.forEach(record => {
    if (!groupedAttendance[record.date]) groupedAttendance[record.date] = [];
    groupedAttendance[record.date].push(record);
  });

  const sortedDates = Object.keys(groupedAttendance).sort((a, b) => {
    const da = a.split('/').reverse().join('/');
    const db = b.split('/').reverse().join('/');
    return db.localeCompare(da);
  });

  const sortedGrouped = {};
  sortedDates.forEach(date => sortedGrouped[date] = groupedAttendance[date]);

  res.render('attendance', {
    displayName: user.displayName,
    position: user.position,
    rank: user.rank,
    avatar: user.avatar,
    role: user.role,

    currentMonth: currentMonthStr,
    monthlySalary: monthlySalary.toLocaleString(),
    salaryRate: user.salaryRate.toLocaleString(),
    careerTotal: user.careerTotal.toLocaleString(),

    isOnDuty,
    todayHours: completedHoursToday.toFixed(2),
    maxDailyHours: 4,
    canCheckIn: remainingHoursToday > 0 && !isOnDuty,

    groupedAttendance: sortedGrouped,
    monthlyHistory: user.monthlyHistory,

    error: req.query.error === 'max_hours' ? 'Bạn đã đủ 4 giờ làm việc hôm nay!' : null
  });
});

// ON / OFF DUTY
app.post("/attendance/check", requireAuth, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.session.user.id);
  if (!user) return res.status(403).send("Unauthorized");

  const now = new Date();
  const today = now.toLocaleDateString('en-US');
  const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dayMonth = today.split('/').slice(0, 2).join('/');

  user.attendance = user.attendance || [];
  user.monthlyHistory = user.monthlyHistory || [];
  user.careerTotal = Number(user.careerTotal || 0);
  user.salaryRate = Number(user.salaryRate || 10714);

  let activeSession = user.attendance.find(a => a.date === today && !a.offTime);

  if (activeSession) {
    // OFF DUTY
    const onTimeStr = activeSession.onTime.split(' - ')[0].trim();
    const [m, d, y] = today.split('/');
    const onDateTime = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')} ${onTimeStr}`);

    if (isNaN(onDateTime.getTime())) return res.redirect("/attendance");

    const elapsedHours = (now - onDateTime) / (1000 * 60 * 60);
    activeSession.offTime = `${time} - ${dayMonth}`;

    if (elapsedHours < 1) {
      activeSession.hours = 0;
      activeSession.salary = 0;
      activeSession.status = "Ca dưới 1 tiếng – không tính lương";
    } else {
      const completedHoursToday = user.attendance
        .filter(a => a.date === today && a.offTime && Number(a.hours || 0) > 0)
        .reduce((sum, a) => sum + Number(a.hours || 0), 0);

      const remainingToday = Math.max(0, 4 - completedHoursToday);
      const hoursToAdd = Math.min(elapsedHours, remainingToday);

      const finalHours = Math.round(hoursToAdd * 100) / 100;
      const salaryEarned = Math.round(finalHours * user.salaryRate * 100) / 100;

      activeSession.hours = finalHours;
      activeSession.salary = salaryEarned;

      const newTotalToday = completedHoursToday + finalHours;
      activeSession.status = newTotalToday >= 4 ? "Đủ 4 giờ hôm nay" : "Hoàn thành ca";

      user.careerTotal = Math.round((user.careerTotal + salaryEarned) * 100) / 100;

      const monthKey = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
      let monthData = user.monthlyHistory.find(h => h.month === monthKey);
      if (!monthData) {
        monthData = { month: monthKey, hours: 0, salary: 0 };
        user.monthlyHistory.unshift(monthData);
      }
      monthData.hours = Math.round((Number(monthData.hours || 0) + finalHours) * 100) / 100;
      monthData.salary = Math.round((Number(monthData.salary || 0) + salaryEarned) * 100) / 100;
    }
  } else {
    // ON DUTY
    const completedHoursToday = user.attendance
      .filter(a => a.date === today && a.offTime && Number(a.hours || 0) > 0)
      .reduce((sum, a) => sum + Number(a.hours || 0), 0);

    if (completedHoursToday >= 4) {
      return res.redirect("/attendance?error=max_hours");
    }

    user.attendance.push({
      date: today,
      onTime: `${time} - ${dayMonth}`,
      offTime: null,
      hours: 0,
      salary: 0,
      status: "Đang On-duty"
    });
  }

  saveDB(db);
  res.redirect("/attendance");
});

// Profile
app.get("/profile", requireAuth, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.session.user.id);
  if (!user) return res.redirect("/index.html");

  const now = new Date();
  const currentMonthKey = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  const currentMonthData = user.monthlyHistory?.find(h => h.month === currentMonthKey);
  const currentMonthSalary = currentMonthData ? Math.round(currentMonthData.salary || 0).toLocaleString() : "0";

  res.render('profile', {
    displayName: user.displayName,
    username: user.username,
    position: user.position || "Cảnh sát viên",
    rank: user.rank || "Hạ sĩ",
    avatar: user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName)}&background=random&bold=true`,
    salaryRate: Number(user.salaryRate || 10714).toLocaleString(),
    careerTotal: Number(user.careerTotal || 0).toLocaleString(),
    monthlyHistory: user.monthlyHistory || [],
    success: req.query.success,
    error: req.query.error
  });
});

// Profile history JSON
app.get("/profile/history", requireAuth, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.session.user.id);
  if (!user) return res.json({ history: [], userTotal: 0, serverTotal: 0 });

  const grouped = {};
  (user.attendance || []).forEach(r => {
    if (!grouped[r.date]) grouped[r.date] = [];
    grouped[r.date].push(r);
  });

  const history = Object.keys(grouped)
    .map(date => {
      const recs = grouped[date];
      const hours = recs.reduce((s, r) => s + Number(r.hours || 0), 0);
      const salary = recs.reduce((s, r) => s + Number(r.salary || 0), 0);
      return {
        date,
        hours: Number(hours.toFixed(2)),
        salary: Number(salary)
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  const userTotal = (user.attendance || []).reduce((sum, r) => sum + Number(r.salary || 0), 0);

  const serverTotal = db.users.reduce((total, u) => {
    return total + (u.attendance || []).reduce((s, r) => s + Number(r.salary || 0), 0);
  }, 0);

  res.json({
    history,
    userTotal: formatSalary(userTotal),
    serverTotal: formatSalary(serverTotal)
  });
});

// Avatar upload
app.post("/profile/avatar", requireAuth, upload.single("avatar"), (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.session.user.id);
  if (!user || !req.file) return res.redirect("/profile?error=upload_failed");

  if (user.avatar && user.avatar.startsWith("/storage/avatars/")) {
    const oldPath = path.join(__dirname, "src/public", user.avatar.split('?')[0]);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  user.avatar = `/storage/avatars/${req.file.filename}`;
  saveDB(db);
  res.redirect("/profile?success=avatar_updated");
});

// Delete avatar
app.delete("/profile/avatar", requireAuth, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.session.user.id);
  if (!user) return res.redirect("/profile");

  if (user.avatar && user.avatar.startsWith("/storage/avatars/")) {
    const oldPath = path.join(__dirname, "src/public", user.avatar.split('?')[0]);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  const nameEncoded = encodeURIComponent(user.displayName.trim());
  user.avatar = `https://ui-avatars.com/api/?name=${nameEncoded}&background=random&bold=true&size=256&format=png`;
  saveDB(db);
  res.redirect("/profile?success=avatar_deleted");
});

// Update profile
app.post("/profile/update", requireAuth, upload.single("avatar"), (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.session.user.id);
  if (!user) return res.redirect("/profile");

  const { name_ingame } = req.body;

  if (name_ingame && name_ingame.trim() !== "" && name_ingame.trim() !== user.displayName) {
    const newName = name_ingame.trim();
    if (db.users.some(u => u.displayName.toLowerCase() === newName.toLowerCase() && u.id !== user.id)) {
      return res.redirect("/profile?error=name_exists");
    }
    user.displayName = newName;

    if (user.avatar && user.avatar.includes("ui-avatars.com")) {
      user.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(newName)}&background=random&bold=true`;
    }
  }

  if (req.file) {
    if (user.avatar && user.avatar.startsWith("/storage/avatars/")) {
      const oldPath = path.join(__dirname, "src/public", user.avatar.split('?')[0]);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    user.avatar = `/storage/avatars/${req.file.filename}?v=${Date.now()}`;
  }

  saveDB(db);
  res.redirect("/profile?success=updated");
});

// Settings
app.get("/settings", requireAuth, (req, res) => {
  res.render('settings', { error: req.query.error, success: req.query.success });
});

app.post("/settings", requireAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) return res.redirect("/settings?error=missing");

  const db = loadDB();
  const user = db.users.find(u => u.id === req.session.user.id);
  if (user) {
    user.password = newPassword;
    saveDB(db);
  }
  res.redirect("/settings?success=updated");
});

// OnDuty list
app.get("/onduty", requireAuth, (req, res) => {
  const db = loadDB();
  const today = new Date().toLocaleDateString('en-US');
  const onDutyUsers = db.users.filter(user => {
    return user.attendance?.some(a => a.date === today && !a.offTime);
  });

  res.render('onduty', { onDutyUsers });
});

// Admin: Trang quản lý người dùng
app.get("/admin", requireAdmin, (req, res) => {
  const db = loadDB();

  // Lấy thông tin user một cách an toàn
  const currentUser = req.user || {};

  res.render('admin', {
    db: db,
    error: req.query.error,
    success: req.query.success,
    positions: Object.keys(SALARY_RATES),
    ranks: AVAILABLE_RANKS,

    // === THÊM CÁC BIẾN CHO HEADER (tránh lỗi ReferenceError) ===
    displayName: currentUser.displayName || currentUser.name_ingame || currentUser.username || 'Admin',
    position: currentUser.position || currentUser.rank || 'Quản Trị Viên',
    avatar: currentUser.avatar || 
            `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.displayName || currentUser.username || 'Admin')}&background=D9C077&color=000&bold=true`
    // Nếu không có avatar thật, dùng ui-avatars tạo tạm (đẹp, có chữ cái đầu)
  });
});

// Admin: Đăng ký người dùng mới
app.post("/register", requireAdmin, upload.single('avatar'), (req, res) => {
  const { username, password, password_confirmation, displayName, position, rank } = req.body;

  // Kiểm tra các trường bắt buộc
  if (!username || !password || !password_confirmation || !displayName || !position) {
    return res.redirect("/admin?error=missing_fields");
  }

  // Kiểm tra mật khẩu khớp
  if (password !== password_confirmation) {
    return res.redirect("/admin?error=password_mismatch");
  }

  // Kiểm tra độ dài mật khẩu (ví dụ: tối thiểu 6 ký tự)
  if (password.length < 6) {
    return res.redirect("/admin?error=password_too_short");
  }

  const db = loadDB();

  // Kiểm tra username đã tồn tại
  if (db.users.some(u => u.username === username)) {
    return res.redirect("/admin?error=username_exists");
  }

  // Tính salary
  const salaryRate = getSalaryRate(position);

  // Xử lý avatar nếu có upload
  let avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=random`;
  if (req.file) {
    avatar = `/storage/avatars/${req.file.filename}`;
  }

  const newUser = {
    id: db.users.length + 1,
    username,
    password, // Nên hash password trong hệ thống thực tế
    role: "user",
    displayName,
    position: position.trim(),
    rank: rank ? rank.trim() : "",
    avatar,
    salaryRate,
    careerTotal: 0,
    attendance: [],
    monthlyHistory: []
  };

  db.users.push(newUser);
  saveDB(db);

  res.redirect("/admin?success=created");
});

// Admin panel (quản lý on/off duty)
app.get("/admin-panel", requireAdmin, (req, res) => {
  const db = loadDB();

  const stats = { onDuty: 0, offDuty: 0, notStarted: 0 };
  const today = new Date().toLocaleDateString('en-US');

  db.users.forEach(u => {
    const todayRecords = u.attendance?.filter(a => a.date === today) || [];
    const hasOn = todayRecords.some(r => !r.offTime);
    const hasOff = todayRecords.some(r => r.offTime);

    if (hasOn) stats.onDuty++;
    else if (hasOff) stats.offDuty++;
    else stats.notStarted++;
  });

  res.render('admin-panel', {
    users: db.users,
    stats,
    currentUser: req.session.user,
    success: req.query.success,
    error: req.query.error
  });
});

// Admin toggle on/off
app.post("/admin/toggle-on/:id", requireAdmin, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === parseInt(req.params.id));
  if (!user) return res.redirect("/admin-panel?error=user_not_found");

  const today = new Date().toLocaleDateString('en-US');
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const dayMonth = today.split('/').slice(0, 2).join('/');

  const hasActive = user.attendance?.some(a => a.date === today && !a.offTime);
  if (hasActive) return res.redirect("/admin-panel?error=already_on");

  user.attendance = user.attendance || [];
  user.attendance.push({
    date: today,
    onTime: `${time} - ${dayMonth}`,
    offTime: null,
    hours: 0,
    salary: 0,
    status: "Đang On-duty (Admin bật)"
  });

  saveDB(db);
  res.redirect("/admin-panel?success=on_duty_" + encodeURIComponent(user.displayName));
});

app.post("/admin/toggle-off/:id", requireAdmin, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === parseInt(req.params.id));
  if (!user) return res.redirect("/admin-panel");

  const today = new Date().toLocaleDateString('en-US');
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const dayMonth = today.split('/').slice(0, 2).join('/');

  const activeSession = user.attendance?.find(a => a.date === today && !a.offTime);
  if (!activeSession) return res.redirect("/admin-panel?error=no_active_session");

  const onTimeStr = activeSession.onTime.split(' - ')[0];
  const [d, m, y] = today.split('/');
  const onDateTime = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')} ${onTimeStr}`);
  const elapsedHours = (new Date() - onDateTime) / (1000 * 60 * 60);

  activeSession.offTime = `${time} - ${dayMonth}`;

  if (elapsedHours >= 1) {
    const completedHoursToday = user.attendance
      .filter(a => a.date === today && a.offTime && Number(a.hours || 0) > 0)
      .reduce((sum, a) => sum + Number(a.hours || 0), 0);

    const remainingToday = Math.max(0, 4 - completedHoursToday);
    const hoursToAdd = Math.min(elapsedHours, remainingToday);
    const salaryEarned = Math.round(hoursToAdd * Number(user.salaryRate) * 100) / 100;

    activeSession.hours = Math.round(hoursToAdd * 100) / 100;
    activeSession.salary = salaryEarned;
    activeSession.status = "Hoàn thành ca (Admin tắt)";

    user.careerTotal = Math.round((Number(user.careerTotal || 0) + salaryEarned) * 100) / 100;
  } else {
    activeSession.hours = 0;
    activeSession.salary = 0;
    activeSession.status = "Ca dưới 1 tiếng – không tính lương (Cảnh báo được tắt bởi quản lý)";
  }

  saveDB(db);
  res.redirect("/admin-panel?success=off_duty_" + encodeURIComponent(user.displayName));
});

app.post("/admin/reset-duty/:id", requireAdmin, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === parseInt(req.params.id));
  if (user) {
    const today = new Date().toLocaleDateString('en-US');
    user.attendance = (user.attendance || []).filter(a => a.date !== today);
    saveDB(db);
  }
  res.redirect("/admin-panel?success=reset_ok");
});

// Admin history
app.get("/admin/history/:id", requireAdmin, (req, res) => {
  try {
    const db = loadDB();
    const userId = parseInt(req.params.id);
    const user = db.users.find(u => u.id === userId);

    if (!user) {
      return res.json({ history: [], userTotal: 0, serverTotal: 0 });
    }

    const grouped = {};
    (user.attendance || []).forEach(r => {
      if (!grouped[r.date]) grouped[r.date] = [];
      grouped[r.date].push(r);
    });

    const history = Object.keys(grouped)
      .map(date => {
        const recs = grouped[date];
        const hours = recs.reduce((s, r) => s + Number(r.hours || 0), 0);
        const salary = recs.reduce((s, r) => s + Number(r.salary || 0), 0);

        return {
          date,
          hours: Number(hours.toFixed(2)),
          salary: Number(salary)
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));

    const userTotal = (user.attendance || []).reduce((s, r) => s + Number(r.salary || 0), 0);

    const serverTotal = db.users.reduce((acc, u) => {
      return acc + (u.attendance || []).reduce((s, r) => s + Number(r.salary || 0), 0);
    }, 0);

    res.json({
      history,
      userTotal: Math.round(userTotal),
      serverTotal: Math.round(serverTotal)
    });

  } catch (err) {
    console.error("Lỗi /admin/history/:id:", err);
    res.status(500).json({ history: [], userTotal: 0, serverTotal: 0 });
  }
});

// Admin panel data (realtime)
app.get("/admin-panel-data", requireAdmin, (req, res) => {
  const db = loadDB();
  const today = new Date().toLocaleDateString('en-US');

  const stats = { onDuty: 0, offDuty: 0, notStarted: 0 };

  db.users.forEach(u => {
    const todayRecords = (u.attendance || []).filter(a => a.date === today);
    const hasOn = todayRecords.some(r => !r.offTime);
    const hasOff = todayRecords.some(r => r.offTime);
    if (hasOn) stats.onDuty++;
    else if (hasOff) stats.offDuty++;
    else stats.notStarted++;
  });

  res.json({ users: db.users, stats });
});

// Export Excel
app.get("/export-salary-excel", requireAdmin, (req, res) => {
  try {
    const db = loadDB();
    const today = new Date().toLocaleDateString('en-US');
    const todayFormatted = new Date().toLocaleDateString('vi-VN').replace(/\//g, '-');

    const data = db.users.map(user => {
      const all = user.attendance || [];
      const todayRec = all.filter(r => r.date === today);

      const totalHours = all.reduce((s, r) => s + Number(r.hours || 0), 0);
      const totalSalary = all.reduce((s, r) => s + Number(r.salary || 0), 0);
      const todayHours = todayRec.reduce((s, r) => s + Number(r.hours || 0), 0);
      const todaySalary = todayRec.reduce((s, r) => s + Number(r.salary || 0), 0);

      const formatUSD = (num) => '$' + Number(num).toLocaleString('en-US');

      return {
        "ID": user.id,
        "Họ tên": user.displayName || "Chưa đặt tên",
        "Chức vụ": `${user.position || "Cảnh sát viên"} ${user.rank || ""}`.trim(),
        "Tổng giờ làm": parseFloat(totalHours.toFixed(2)),
        "Tổng lương sự nghiệp": formatUSD(totalSalary),
        "Giờ hôm nay": parseFloat(todayHours.toFixed(2)),
        "Lương hôm nay": formatUSD(todaySalary),
        "Trạng thái hôm nay": todayRec.some(r => !r.offTime) ? "Đang On Duty" :
                              todayRec.length > 0 ? "Đã Off Duty" : "Chưa vào ca"
      };
    });

    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 8 }, { wch: 28 }, { wch: 25 }, { wch: 15 }, { wch: 25 }, { wch: 15 }, { wch: 22 }, { wch: 20 }];

    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cellAddress = XLSX.utils.encode_cell({ r: 0, c: C });
      if (!ws[cellAddress]) continue;
      ws[cellAddress].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "FFB74D" } },
        alignment: { horizontal: "center", vertical: "center" }
      };
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Lương Nhân Viên");

    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });

    res.setHeader('Content-Disposition', `attachment; filename="Luong_Toan_Server_${todayFormatted}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    console.error("Lỗi xuất Excel:", err);
    res.status(500).send("Lỗi server khi xuất file Excel.");
  }
});

// Admin actions
app.post("/admin/role/:id", requireAdmin, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === parseInt(req.params.id));
  if (user && ['admin', 'user'].includes(req.body.role)) {
    user.role = req.body.role;
    saveDB(db);
  }
  res.redirect("/admin?success=updated");
});

app.post("/admin/delete/:id", requireAdmin, (req, res) => {
  const db = loadDB();
  const index = db.users.findIndex(u => u.id === parseInt(req.params.id));
  if (index !== -1) {
    db.users.splice(index, 1);
    db.users.forEach((u, i) => u.id = i + 1);
    saveDB(db);
  }
  res.redirect("/admin?success=deleted");
});

app.post("/admin/reset-salary/:id", requireAdmin, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === parseInt(req.params.id));
  if (user) {
    user.attendance = [];
    user.monthlyHistory = [];
    user.careerTotal = 0;
    saveDB(db);
  }
  res.redirect("/admin-panel");
});

app.post("/admin/reset-all-salary", requireAdmin, (req, res) => {
  const db = loadDB();
  db.users.forEach(u => {
    u.attendance = [];
    u.monthlyHistory = [];
    u.careerTotal = 0;
  });
  saveDB(db);
  res.redirect("/admin-panel");
});

app.post("/admin/reset-day/:id", requireAdmin, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === parseInt(req.params.id));
  const dateToDelete = req.body.date?.trim();

  if (user && dateToDelete) {
    user.attendance = user.attendance.filter(r => r.date !== dateToDelete);
    user.careerTotal = user.attendance.reduce((s, r) => s + Number(r.salary || 0), 0);
    saveDB(db);
  }
  res.redirect("/admin-panel");
});
// Cập nhật Quân hàm (position) - chỉ hiển thị, không ảnh hưởng lương
app.post("/admin/update-position/:id", requireAdmin, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === parseInt(req.params.id));

  if (!user) {
    return res.redirect("/admin?error=user_not_found");
  }

  const newPosition = req.body.position?.trim() || "";
  const oldPosition = user.position;

  // Cập nhật position
  user.position = newPosition;

  // Nếu bạn muốn quân hàm (position) cũng ảnh hưởng lương → thêm logic này
  // (Hiện tại bảng SALARY_RATES dùng rank, nếu bạn muốn dùng position thì sửa key)
  // Ví dụ: nếu position cũng có trong SALARY_RATES thì cập nhật
  if (newPosition && SALARY_RATES[newPosition]) {
    user.salaryRate = SALARY_RATES[newPosition];
  }

  saveDB(db);

  // Ghi log
  const logDetail = oldPosition !== newPosition 
    ? `Quân hàm từ "${oldPosition || 'Không có'}" → "${newPosition || 'Không có'}"`
    : "Không thay đổi quân hàm";

  addLog(req.session.user.username || 'Admin', "CẬP NHẬT QUÂN HÀM", user.displayName, logDetail);

  res.redirect("/admin?success=updated_position");
});
app.post("/admin/update-position/:id", requireAdmin, (req, res) => {
  const db = loadDB();
  const userId = parseInt(req.params.id);
  const user = db.users.find(u => u.id === userId);
  if (!user) {
    return res.redirect("/admin?error=user_not_found");
  }

  // Nếu chọn "-- Không có --" thì để trống, còn lại lưu giá trị chọn
  const newPosition = req.body.position?.trim();
  user.position = newPosition || "";

  saveDB(db);
  res.redirect("/admin?success=updated");
});


// AUTO OFF DUTY KHI TREO CA (bản cuối cùng, đã fix)
app.use((req, res, next) => {
  if (!req.session.user) return next();

  const db = loadDB();
  const user = db.users.find(u => u.id === req.session.user.id);
  if (!user || !user.attendance || user.attendance.length === 0) return next();

  const now = new Date();
  const todayStr = now.toLocaleDateString('en-US');

  const hangingSession = user.attendance.find(a => !a.offTime && a.date !== todayStr);

  if (hangingSession) {
    try {
      const [m, d, y] = hangingSession.date.split('/');
      const onTimeStr = hangingSession.onTime.split(' - ')[0];
      const onDateTime = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')} ${onTimeStr}`);
      const forcedOffDateTime = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')} 23:59:59`);

      let elapsedHours = (forcedOffDateTime - onDateTime) / (1000 * 60 * 60);
      elapsedHours = Math.max(0, elapsedHours);

      const hoursToAdd = Math.min(elapsedHours, 4);
      const salaryRate = Number(user.salaryRate) || 10714;
      const salaryEarned = Math.round(hoursToAdd * salaryRate * 100) / 100;

      if (hoursToAdd > 0) {
        hangingSession.offTime = `23:59 - ${m.padStart(2,'0')}/${d.padStart(2,'0')}`;
        hangingSession.hours = Math.round(hoursToAdd * 100) / 100;
        hangingSession.salary = salaryEarned;
        hangingSession.status = "Đã Đạt Giới Hạn (Hệ Thống Tự Động)";

        user.careerTotal = Math.round((Number(user.careerTotal || 0) + salaryEarned) * 100) / 100;

        const monthKey = `${m.padStart(2, '0')}/${y}`;
        let monthData = user.monthlyHistory.find(h => h.month === monthKey);
        if (!monthData) {
          monthData = { month: monthKey, hours: 0, salary: 0 };
          user.monthlyHistory.unshift(monthData);
        }
        monthData.hours = Math.round((Number(monthData.hours || 0) + hoursToAdd) * 100) / 100;
        monthData.salary = Math.round((Number(monthData.salary || 0) + salaryEarned) * 100) / 100;

        saveDB(db);
        console.log(`[AUTO-OFF SUCCESS] ${user.displayName}: +${salaryEarned}$ cho ngày ${hangingSession.date}`);
      } else {
        hangingSession.offTime = `00:00 - ${m.padStart(2,'0')}/${d.padStart(2,'0')}`;
        hangingSession.status = "Ca lỗi - Hệ thống tự chốt";
        saveDB(db);
      }
    } catch (err) { 
      console.error("Lỗi Auto-Off:", err);
    }
  }
  next();
  
});
// Cấu hình để đọc dữ liệu từ Form (POST)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 1. Tuyến đường hiển thị trang quản lý
app.post('/admin/create-user', upload.single('avatar'), (req, res) => {
    try {
        const db = loadDB(); // <--- PHẢI CÓ DÒNG NÀY ĐỂ HẾT LỖI db is not defined
        const { displayName, username, password, confirmPassword, rank, position } = req.body;

        // Kiểm tra trùng username
        if (db.users.find(u => u.username === username)) {
            return res.redirect('/admin/users?error=exists');
        }

        const newUser = {
            id: Date.now(),
            username,
            password, // Bạn nên mã hóa mật khẩu nếu cần
            displayName,
            rank,
            position,
            avatar: req.file ? req.file.filename : null,
            createdAt: new Date(),
            createdBy: req.session.user.username
        };

        db.users.push(newUser);
        saveDB(db);

        // Ghi log hành động
        addLog(req.session.user.username, "TẠO NHÂN SỰ", displayName, `Chức vụ: ${rank}`);

        // KẾT THÚC BẰNG REDIRECT ĐỂ HẾT XOAY MÀN HÌNH
        res.redirect('/admin/users?success=created');
    } catch (err) {
        console.error(err);
        res.status(500).send("Lỗi server rồi đại ca ơi!");
    }
});

// Cập nhật Chức vụ (Rank)
app.post("/admin/update-rank/:id", requireAdmin, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === parseInt(req.params.id));

  if (!user) {
    return res.redirect("/admin?error=user_not_found");
  }

  const newRank = req.body.rank?.trim() || "";
  const oldRank = user.rank;

  // Cập nhật rank
  user.rank = newRank;

  // Tự động cập nhật salaryRate dựa trên rank mới
  if (newRank && SALARY_RATES[newRank]) {
    user.salaryRate = SALARY_RATES[newRank];
  } else if (newRank === "") {
    // Nếu bỏ chọn chức vụ → reset về mặc định (hoặc 0)
    user.salaryRate = 10714; // hoặc giá trị mặc định bạn muốn
  }

  saveDB(db);

  // Ghi log chi tiết (bao gồm thay đổi lương)
  const logDetail = oldRank !== newRank 
    ? `Chức vụ từ "${oldRank || 'Không có'}" → "${newRank || 'Không có'}" | Hệ số lương mới: ${user.salaryRate}$/h`
    : "Không thay đổi chức vụ";

  addLog(req.session.user.username || 'Admin', "CẬP NHẬT CHỨC VỤ", user.displayName, logDetail);

  res.redirect("/admin?success=updated_rank");
});
app.post("/admin/update-rank/:id", requireAdmin, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === parseInt(req.params.id));
  if (user) {
    user.rank = req.body.rank || "";
    saveDB(db);
  }
  res.redirect("/admin?success=updated");
});

// Cập nhật Quân hàm (Position)
app.post("/admin/update-position/:id", requireAdmin, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === parseInt(req.params.id));
  if (user) {
    user.position = req.body.position || "";
    saveDB(db);
  }
  res.redirect("/admin?success=updated");
});

// 4. Cập nhật Role (Quyền)
app.post('/admin/role/:id', (req, res) => {
    const user = db.users.find(u => u.id == req.params.id);
    if (user) user.role = req.body.role;
    res.redirect('/admin/users?success=updated');
});

// 5. Xóa nhân sự
app.post('/admin/delete/:id', (req, res) => {
    const user = db.users.find(u => u.id === req.params.id);
    // ... code xóa của bạn ...
    
    // Gọi hàm ghi log ở đây:
    writeLog(req.session.user.username, "XÓA", user.displayName, "Đã chuyển vào thùng rác");
    
    res.redirect('/admin/users');
});

// 6. Tạo nhân sự mới
app.post('/admin/create-user', (req, res) => {
    // ... code tạo user của bạn ...
    const displayName = req.body.displayName;
    
    // Gọi hàm ghi log ở đây:
    writeLog(req.session.user.username, "Tạo mới", displayName, "Sĩ quan mới vừa gia nhập");
    
    res.redirect('/admin/users');
});
app.post('/admin/update-user', requireAdmin, (req, res) => {
    const db = loadDB();
    const { userId, name_ingame, rank, position } = req.body;
    const user = db.users.find(u => u.id === parseInt(userId));

    if (user) {
        // Lưu lại quân hàm cũ để ghi log chi tiết (không bắt buộc)
        const oldRank = user.rank;

        // Cập nhật thông tin
        user.displayName = name_ingame.trim();
        user.rank = rank;
        user.position = position || "";
        saveDB(db);

        // --- DÒNG QUAN TRỌNG: Gọi log ở đây ---
        // Sử dụng từ khóa "cập nhật" để Modal Lịch sử hiện màu vàng
        writeLog(
            req.session.user.displayName, 
            "cập nhật", 
            user.displayName, 
            `Thay đổi quân hàm từ ${oldRank} thành ${rank}`
        );

        res.redirect('/admin/panel?success=updated');
    } else {
        res.redirect('/admin/panel?error=notfound');
    }
});
// Cập nhật nhân sự từ modal
app.post("/admin/update-user", requireAdmin, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === parseInt(req.body.userId));
  if (user) {
    user.displayName = req.body.name_ingame.trim();
    user.rank = req.body.rank;
    user.position = req.body.position || "";
    saveDB(db);
  }
  res.redirect("/admin?success=updated");
});

// Đổi mật khẩu (tạm set 123)
app.post("/admin/reset-password/:id", requireAdmin, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === parseInt(req.params.id));
  if (user) {
    user.password = "123";
    saveDB(db);
  }
  res.json({ success: true });
});
// Route xử lý xóa ca trực
app.post('/admin/delete-duty/:id', async (req, res) => {
    try {
        const userId = req.params.id;
        
        // Logic tìm user và xóa bản ghi attendance chưa có offTime
        // Ví dụ sử dụng Mongoose:
        await User.updateOne(
            { id: userId, "attendance.offTime": { $exists: false } },
            { $pull: { attendance: { offTime: { $exists: false } } } }
        );

        // Sau khi xóa xong, quay lại trang onduty
        res.redirect('/onduty');
    } catch (err) {
        console.error(err);
        res.status(500).send("Lỗi máy chủ khi xóa ca trực");
    }
});
// Hàm giả lập load dữ liệu lương (Sau này bạn thay bằng fetch tới API thực tế)
function loadUserSalary(userId, userName) {
    document.getElementById('salaryTargetName').textContent = userName;
    
    // Giả lập dữ liệu từ Database gửi về
    const fakeAttendance = [
        { id: 'ca01', date: '10/01/2026', onTime: '08:00', offTime: '10:00', totalMin: 120 },
        { id: 'ca02', date: '11/01/2026', onTime: '14:00', offTime: '17:30', totalMin: 210 }
    ];
    const rate = 50; // Giả sử 50$/h

    const tbody = document.getElementById('salaryDetailBody');
    tbody.innerHTML = '';
    let totalMin = 0;

    fakeAttendance.forEach(item => {
        totalMin += item.totalMin;
        const subTotal = (item.totalMin / 60) * rate;
        
        tbody.innerHTML += `
            <tr>
                <td>${item.date}</td>
                <td>${item.onTime}</td>
                <td><span class="badge bg-secondary">${item.offTime}</span></td>
                <td>${item.totalMin} phút</td>
                <td class="fw-bold text-success">${subTotal.toLocaleString()}$</td>
                <td>
                    <button class="btn btn-outline-danger btn-sm" onclick="deleteSalaryRecord('${userId}', '${item.id}')">
                        <i class="fa-solid fa-trash-can"></i> Xóa
                    </button>
                </td>
            </tr>
        `;
    });

    // Cập nhật các con số tổng quát
    const totalH = (totalMin / 60).toFixed(2);
    document.getElementById('totalHours').textContent = totalH + 'h';
    document.getElementById('ratePerHour').textContent = rate.toLocaleString() + '$/h';
    document.getElementById('totalSalary').textContent = (totalH * rate).toLocaleString() + '$';
}

// Hàm xử lý xóa 1 bản ghi lương
function deleteSalaryRecord(userId, recordId) {
    Swal.fire({
        title: 'Xóa ca làm việc?',
        text: "Hành động này sẽ trừ tiền lương của nhân sự trong ngày này!",
        icon: 'error',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: 'Đúng, xóa nó!'
    }).then((result) => {
        if (result.isConfirmed) {
            // Gửi request tới server (Ví dụ: fetch('/admin/delete-record/' + recordId, {method: 'DELETE'}))
            Swal.fire('Đã xóa!', 'Bản ghi lương đã được loại bỏ.', 'success');
            // Sau khi xóa xong có thể gọi lại loadUserSalary() để refresh modal
        }
    })
}// ====================== ROUTE ADMIN-VIEWONDUTY (LIVE ON-DUTY) ======================
app.get('/admin-viewonduty', requireAdmin, async (req, res) => {
  try {
    const db = loadDB(); // hàm load database.json của bạn

    const today = new Date().toLocaleDateString('en-US'); // định dạng ngày như trong DB

    // Tính stats realtime hôm nay
    let onDuty = 0;
    let offToday = 0;
    let notStarted = 0;

    db.users.forEach(user => {
      const attendance = user.attendance || [];
      const todayRecord = attendance.find(a => a.date === today);

      if (todayRecord) {
        if (!todayRecord.offTime) {
          onDuty++;
        } else {
          offToday++;
        }
      } else {
        notStarted++;
      }
    });

    // Render trang EJS (đảm bảo file tên admin-viewonduty.ejs trong src/public/)
    res.render('admin-viewonduty', {
      users: db.users,                          // danh sách tất cả nhân viên
      stats: { onDuty, offToday, notStarted },  // thống kê
      currentUser: req.session.user || { displayName: 'Admin' }
    });

  } catch (err) {
    console.error('Lỗi route /admin-viewonduty:', err);
    res.status(500).send('Lỗi server khi tải trang On-Duty Live');
  }
});
// Route xử lý xóa ca làm việc LIVE
app.post('/admin/delete-duty/:id', async (req, res) => {
    try {
        const userId = req.params.id;

        // 1. Tìm nhân viên và xóa bản ghi attendance chưa kết thúc (không có offTime)
        // Lệnh $pull sẽ gỡ bỏ hoàn toàn phần tử đó khỏi mảng attendance
        await User.updateOne(
            { id: userId }, 
            { 
                $pull: { 
                    attendance: { offTime: { $exists: false } } 
                } 
            }
        );

        console.log(`Đã xóa ca trực của ID: ${userId} - Hệ thống sẽ không tính lương.`);
        
        // 2. Quay lại trang quản lý sau khi xóa xong
        res.redirect('/onduty');

    } catch (error) {
        console.error("Lỗi khi xóa ca trực:", error);
        res.status(500).send("Lỗi máy chủ: Không thể xóa ca trực của " + req.params.id);
    }
});
app.listen(PORT, () => {
  console.log(`PA Timekeeping System chạy tại http://localhost:${PORT}`);
});
// Lấy lịch sử của một user
app.get('/payroll/user/:id', requireAuth, (req, res) => {
    const db = loadDB();
    const targetUser = db.users.find(u => u.id === parseInt(req.params.id));

    if (!targetUser) {
        return res.status(404).send('Không tìm thấy sĩ quan');
    }

    // === TÍNH TOÁN (giữ nguyên code cũ của bạn) ===
    const attendances = targetUser.attendance || [];

    // Tháng hiện tại
    const now = new Date();
    const currentMonthKey = `${now.getMonth() + 1}/${now.getFullYear()}`;

    // Lọc attendance tháng hiện tại
    const currentMonthAttendances = attendances.filter(att => {
        const d = new Date(att.date || att.check_in || att.check_out);
        return d.getMonth() + 1 === now.getMonth() + 1 && d.getFullYear() === now.getFullYear();
    });

    // TÍNH monthlyTotal (tổng lương tháng hiện tại)
    const monthlyTotal = currentMonthAttendances.reduce((sum, att) => {
        return sum + Number(att.wage || att.salary || 0);
    }, 0);

    // Các biến khác (bạn đã có)
    const heSoLuong = targetUser.salaryRate || 10714;
    const totalLuong = targetUser.careerTotal || 0;
    const totalHours = currentMonthAttendances.reduce((s, a) => s + Number(a.duration || 0), 0);
    const totalWage = monthlyTotal; // nếu trùng

    // ... tiếp tục tính groupedByMonth, monthlySummaries, paginated, v.v.

    // === RENDER – PHẢI thêm monthlyTotal ===
res.render('payroll-modern', {
    user: targetUser,
    month: currentMonthKey,
    monthlyTotal,  // tổng lương tháng này
    heSoLuong: targetUser?.salaryRate || 10714,
    totalLuong: targetUser?.careerTotal || 0,
    totalHours,
    totalWage,
    currentAttendances: currentMonthAttendances,
    groupedByMonth: groupedData,
    monthlySummaries: summaries,
    currentMonth: currentMonthKey,
    csrfToken: ''
});
});


// Cập nhật inline (AJAX)
app.post('/payroll/user/:id', requireAuth, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === parseInt(req.params.id));
    if (!user) return res.json({ success: false, message: 'Không tìm thấy' });

    const { field, value } = req.body;
    const attendance = user.attendance.find(a => a.id === field); // giả sử mỗi record có id riêng

    if (!attendance) return res.json({ success: false, message: 'Không tìm thấy bản ghi' });

    if (['duration', 'wage', 'status'].includes(field)) {
        attendance[field] = field === 'duration' ? parseFloat(value) : field === 'wage' ? parseFloat(value) : value;
    }

    // Cập nhật tổng sự nghiệp nếu cần
    user.careerTotal = user.attendance.reduce((sum, a) => sum + Number(a.wage || 0), 0);

    saveDB(db);

    // Trả về tổng tháng mới
    const now = new Date();
    const currentMonthKey = `${now.getMonth() + 1}/${now.getFullYear()}`;
    const currentMonth = user.attendance.filter(a => {
        const d = new Date(a.date || a.check_in);
        return d.getMonth() + 1 === now.getMonth() + 1 && d.getFullYear() === now.getFullYear();
    });

    const total_hours = currentMonth.reduce((s, a) => s + Number(a.duration || 0), 0);
    const total_wage = currentMonth.reduce((s, a) => s + Number(a.wage || 0), 0);

    res.json({
        success: true,
        summary: {
            total_hours,
            total_hours_formatted: total_hours.toFixed(2),
            total_wage,
            total_wage_formatted: total_wage.toLocaleString()
        }
    });
});

// Xóa bản ghi chấm công
app.delete('/attendance/:id', requireAuth, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.attendance?.some(a => a.id === parseInt(req.params.id)));
    if (user) {
        user.attendance = user.attendance.filter(a => a.id !== parseInt(req.params.id));
        user.careerTotal = user.attendance.reduce((s, a) => s + Number(a.wage || 0), 0);
        saveDB(db);
    }
    res.redirect(req.headers.referer || '/payroll');
    app.get('/payroll/user/:id', requireAuth, (req, res) => {
    const db = loadDB();
    const targetUser = db.users.find(u => u.id === parseInt(req.params.id));

    if (!targetUser) {
        return res.status(404).send('Không tìm thấy sĩ quan');
    }

    // Tính toán các biến khác (giữ nguyên code của bạn)
    // ...

    res.render('payroll', {
        user: targetUser,           // <-- Đây là fix chính
        // các biến khác...
        currentAttendances,
        monthlySummaries,
        month: currentMonthKey,
        monthlyTotal,
        totalLuong: targetUser.careerTotal || 0,
        heSoLuong: targetUser.salaryRate || 10714,
        
        // ...
    });
    const employeeSelect = document.getElementById('employeeSelect');
const searchBtn = document.getElementById('searchBtn');
const tableBody = document.querySelector('#attendanceTable tbody');
const employeeTitle = document.getElementById('employeeTitle');

let employees = [];

// Load danh sách nhân viên
fetch('/api/employees')
  .then(res => res.json())
  .then(data => {
    employees = data;
    employeeSelect.innerHTML = '<option value="">-- Chọn nhân viên --</option>';
    data.forEach(emp => {
      const opt = document.createElement('option');
      opt.value = emp.employee_id;
      opt.textContent = `${emp.employee_name} (${emp.employee_id})`;
      employeeSelect.appendChild(opt);
    });
  });
// GET lịch sử
router.get('/admin/onduty-history/:userId', isAdmin, async (req, res) => {
  const { userId } = req.params;
  const { start_date, end_date } = req.query;

  let query = `SELECT * FROM onduty_logs WHERE user_id = ? AND deleted = 0`;
  const params = [userId];

  if (start_date) {
    query += ' AND date(timestamp) >= ?';
    params.push(start_date);
  }
  if (end_date) {
    query += ' AND date(timestamp) <= ?';
    params.push(end_date);
  }
  query += ' ORDER BY timestamp DESC';

  const logs = await db.all(query, params); // giả sử dùng sqlite3

  res.render('partials/onduty-tbody', { logs, moment: require('moment-timezone') });
});
app.get('/payroll', (req, res) => {
    // Lấy dữ liệu từ DB
    const payrollData = [ /* mảng dữ liệu fake hoặc từ DB */ ];
    res.render('payroll', { payrollData, month: 1, totalSalary: 19236780, totalEmployees: 76, checkedIn: 62 });
});
// POST xóa
router.post('/admin/onduty-delete/:logId', isAdmin, async (req, res) => {
  const { logId } = req.params;
  await db.run('UPDATE onduty_logs SET deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [logId]);
  res.json({ success: true });
});
// Tìm kiếm
searchBtn.addEventListener('click', () => {
  const empId = employeeSelect.value;
  if (!empId) {
    alert('Vui lòng chọn nhân viên!');
    return;
  }
// Trong file routes/admin.js (hoặc nơi bạn định nghĩa router)
const express = require('express');
const router = express.Router();

// ... các route cũ của bạn ...

// Route mới: Xem chi tiết nhân sự
router.get('/admin/user-detail/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Lấy thông tin user từ DB (giả sử dùng sqlite3 hoặc model Sequelize/Mongoose)
    const user = await db.get(`
      SELECT * FROM users 
      WHERE id = ?
    `, [id]);

    if (!user) {
      req.flash('error', 'Không tìm thấy nhân sự');
      return res.redirect('/admin');
    }

    // Lấy thêm dữ liệu liên quan nếu cần (ví dụ: lịch sử chấm công, on/off duty, lương...)
    const attendance = await db.all(`
      SELECT * FROM attendance 
      WHERE employee_id = ? 
      ORDER BY timestamp DESC LIMIT 50
    `, [user.id]);

    // Render trang chi tiết
    res.render('admin/user-detail', {
      title: `Chi tiết: ${user.displayName || user.username}`,
      user,
      attendance,
      moment: require('moment-timezone'),
      messages: req.flash()
    });

  } catch (err) {
    console.error('Lỗi xem chi tiết user:', err);
    req.flash('error', 'Có lỗi xảy ra');
    res.redirect('/admin');
  }
});
// Route xem chi tiết nhân sự
router.get('/admin/user-detail/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Lấy thông tin user từ database (thay db.get bằng cách query thật của bạn)
    const user = await db.get(`
      SELECT 
        id, username, displayName, rank, position, 
        discordId, discord_id, avatar, createdAt, createdBy
      FROM users 
      WHERE id = ?
    `, [id]);

    if (!user) {
      req.flash('error', 'Không tìm thấy nhân sự');
      return res.redirect('/admin');
    }

    // (Tùy chọn) Lấy thêm lịch sử chấm công hoặc on/off nếu muốn hiển thị
    // const attendance = await db.all(`SELECT * FROM attendance WHERE employee_id = ? ORDER BY timestamp DESC LIMIT 20`, [id]);

    res.render('admin/user-detail', { 
      title: `Chi tiết: ${user.displayName || user.username}`,
      user,
      moment: require('moment-timezone'), // nếu bạn dùng moment để format ngày
      messages: req.flash()
    });

  } catch (err) {
    console.error('Lỗi xem chi tiết user:', err);
    req.flash('error', 'Có lỗi hệ thống, vui lòng thử lại');
    res.redirect('/admin');
  }
});
// Route xem chi tiết nhân sự
router.get('/admin/user-detail/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Query lấy thông tin user (thay db.get bằng cách query thật của bạn - sqlite3, mysql2, sequelize...)
    const user = await db.get(`
      SELECT 
        id, username, displayName, rank, position, 
        discordId, discord_id, avatar, createdAt, createdBy
      FROM users 
      WHERE id = ?
    `, [id]);

    if (!user) {
      req.flash('error', 'Không tìm thấy nhân sự với ID này');
      return res.redirect('/admin');
    }

    // (Tùy chọn) Lấy thêm dữ liệu liên quan nếu bạn muốn hiển thị
    // const attendance = await db.all(`SELECT * FROM attendance WHERE employee_id = ? ORDER BY timestamp DESC LIMIT 20`, [id]);

    // Render trang chi tiết
    res.render('admin/user-detail', {
      title: `Chi tiết: ${user.displayName || user.username}`,
      user,
      moment: require('moment-timezone'), // nếu dùng moment để format ngày giờ
      messages: req.flash()
    });

  } catch (err) {
    console.error('Lỗi khi xem chi tiết nhân sự:', err);
    req.flash('error', 'Có lỗi hệ thống, vui lòng thử lại');
    res.redirect('/admin');
  }
});
const isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  req.flash('error', 'Bạn không có quyền truy cập');
  res.redirect('/login');
};
// Cập nhật thông tin nhân sự - Route POST
router.post('/update-user', isAdmin, upload.single('avatar'), (req, res) => {
  try {
    const db = loadDB();
    const { userId, displayName, rank, position } = req.body;

    console.log('[DEBUG UPDATE] Nhận request cho userId:', userId); // Log để kiểm tra
    console.log('[DEBUG] Dữ liệu nhận được:', req.body);

    const user = db.users.find(u => u.id === parseInt(userId));
    if (!user) {
      console.log('[DEBUG] Không tìm thấy user với ID:', userId);
      return res.status(404).json({ success: false, message: 'Không tìm thấy nhân sự' });
    }

    // Cập nhật thông tin
    if (displayName) user.displayName = displayName.trim();
    if (rank) user.rank = rank.trim();
    if (position) user.position = position.trim();

    // Xử lý avatar mới nếu upload
    if (req.file) {
      if (user.avatar && user.avatar.startsWith('/storage/avatars/')) {
        const oldPath = path.join(__dirname, '..', 'src/public', user.avatar);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      user.avatar = `/storage/avatars/${req.file.filename}`;
    }

    saveDB(db);

    // Ghi log hành động
    addLog(req.session.user.username || 'Admin', 'CẬP NHẬT', user.displayName, 'Chỉnh sửa thông tin');

    res.json({ success: true, message: 'Cập nhật thành công!' });

  } catch (err) {
    console.error('[LỖI UPDATE USER]:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server khi cập nhật' });
  }
  // Cập nhật thông tin nhân sự - Route POST
router.post('/update-user', isAdmin, upload.single('avatar'), (req, res) => {
  try {
    const db = loadDB();
    const { userId, displayName, rank, position } = req.body;
const adminRouter = require('./routes/admin'); // thay './routes/admin' bằng đường dẫn thật
app.use('/admin', adminRouter);  // <-- PHẢI có '/admin' ở đây
    console.log('[DEBUG UPDATE] Nhận request cho userId:', userId); // Log để kiểm tra
    console.log('[DEBUG] Dữ liệu nhận được:', req.body);

    const user = db.users.find(u => u.id === parseInt(userId));
    if (!user) {
      console.log('[DEBUG] Không tìm thấy user với ID:', userId);
      return res.status(404).json({ success: false, message: 'Không tìm thấy nhân sự' });
    }

    // Cập nhật thông tin
    if (displayName) user.displayName = displayName.trim();
    if (rank) user.rank = rank.trim();
    if (position) user.position = position.trim();

    // Xử lý avatar mới nếu upload
    if (req.file) {
      if (user.avatar && user.avatar.startsWith('/storage/avatars/')) {
        const oldPath = path.join(__dirname, '..', 'src/public', user.avatar);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      user.avatar = `/storage/avatars/${req.file.filename}`;
    }

    saveDB(db);

    // Ghi log hành động
    addLog(req.session.user.username || 'Admin', 'CẬP NHẬT', user.displayName, 'Chỉnh sửa thông tin');

    res.json({ success: true, message: 'Cập nhật thành công!' });

  } catch (err) {
    console.error('[LỖI UPDATE USER]:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server khi cập nhật' });
  }
});
});
module.exports = router;
  const start = document.getElementById('startDate').value;
  const end = document.getElementById('endDate').value;

  let url = `/api/attendance/${empId}`;
  if (start || end) {
    url += '?';
    if (start) url += `startDate=${start}`;
    if (end) url += `${start ? '&' : ''}endDate=${end}`;
  }

  fetch(url)
    .then(res => res.json())
    .then(data => {
      const emp = employees.find(e => e.employee_id === empId);
      employeeTitle.textContent = emp 
        ? `Lịch sử chấm công: ${emp.employee_name} (${emp.employee_id})`
        : 'Không tìm thấy nhân viên';

      tableBody.innerHTML = '';

      if (data.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" class="text-center">Không có dữ liệu</td></tr>';
        return;
      }

      data.forEach(row => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${row.date}</td>
          <td>${row.time}</td>
          <td>
            <span class="badge ${row.check_type === 'checkin' ? 'bg-success' : 'bg-danger'}">
              ${row.check_type === 'checkin' ? 'Vào' : 'Ra'}
            </span>
          </td>
          <td>${row.note || '-'}</td>
          <td>${row.device || '-'}</td>
        `;
        tableBody.appendChild(tr);
      });
    })
    .catch(err => {
      console.error(err);
      alert('Có lỗi xảy ra');
    });
});
// Cập nhật thông tin nhân sự (POST)
router.post('/update-user', requireAdmin, upload.single('avatar'), (req, res) => {
  try {
    const db = loadDB();
    const { userId, displayName, rank, position } = req.body;

    const user = db.users.find(u => u.id === parseInt(userId));
    if (!user) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy nhân sự' });
    }

    // Cập nhật thông tin
    if (displayName) user.displayName = displayName.trim();
    if (rank) user.rank = rank;
    if (position) user.position = position;

    // Cập nhật avatar nếu upload mới
    if (req.file) {
      // Xóa avatar cũ nếu có
      if (user.avatar && user.avatar.startsWith('/storage/avatars/')) {
        const oldPath = path.join(__dirname, '..', 'src/public', user.avatar);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      user.avatar = `/storage/avatars/${req.file.filename}`;
    }

    saveDB(db);

    // Ghi log hành động
    addLog(req.session.user.username, "CẬP NHẬT", user.displayName, `Chỉnh sửa thông tin`);

    res.json({ success: true });

  } catch (err) {
    console.error('Lỗi update user:', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});
// Cập nhật thông tin nhân sự (POST)
router.post('/admin/update-user', isAdmin, upload.single('avatar'), (req, res) => {
  try {
    const db = loadDB();
    const { userId, displayName, rank, position } = req.body;

    // Tìm user theo ID
    const user = db.users.find(u => u.id === parseInt(userId));
    if (!user) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy nhân sự' });
    }

    // Cập nhật thông tin
    if (displayName) user.displayName = displayName.trim();
    if (rank) user.rank = rank.trim();
    if (position) user.position = position.trim();

    // Cập nhật avatar nếu upload mới
    if (req.file) {
      // Xóa avatar cũ nếu có
      if (user.avatar && user.avatar.startsWith('/storage/avatars/')) {
        const oldPath = path.join(__dirname, '..', 'src/public', user.avatar);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      user.avatar = `/storage/avatars/${req.file.filename}`;
    }

    saveDB(db);

    // Ghi log hành động
    addLog(req.session.user.username || 'Admin', "CẬP NHẬT", user.displayName, `Chỉnh sửa thông tin`);

    res.json({ success: true, message: 'Cập nhật thành công!' });

  } catch (err) {
    console.error('Lỗi update user:', err);
    res.status(500).json({ success: false, message: 'Lỗi server khi cập nhật' });
  }
});
// Cập nhật thông tin nhân sự
router.post('/admin/update-user', isAdmin, upload.single('avatar'), (req, res) => {
  try {
    const db = loadDB();
    const { userId, displayName, rank, position } = req.body;

    const user = db.users.find(u => u.id === parseInt(userId));
    if (!user) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy nhân sự' });
    }

    // Cập nhật thông tin
    if (displayName) user.displayName = displayName.trim();
    if (rank) user.rank = rank.trim();
    if (position) user.position = position.trim();

    // Avatar mới nếu upload
    if (req.file) {
      if (user.avatar && user.avatar.startsWith('/storage/avatars/')) {
        const oldPath = path.join(__dirname, '..', 'src/public', user.avatar);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      user.avatar = `/storage/avatars/${req.file.filename}`;
    }

    saveDB(db);

    // Ghi log
    addLog(req.session.user.username || 'Admin', 'CẬP NHẬT', user.displayName, 'Chỉnh sửa thông tin');

    res.json({ success: true, message: 'Cập nhật thành công!' });

  } catch (err) {
    console.error('Lỗi update user:', err);
    res.status(500).json({ success: false, message: 'Lỗi server khi cập nhật' });
  }
});
// Cập nhật thông tin nhân sự
router.post('/update-user', isAdmin, upload.single('avatar'), (req, res) => {
  try {
    const db = loadDB();
    const { userId, displayName, rank, position } = req.body;

    console.log('DEBUG: Nhận request update userId =', userId); // Log để debug

    const user = db.users.find(u => u.id === parseInt(userId));
    if (!user) {
      console.log('Không tìm thấy user với ID:', userId);
      return res.status(404).json({ success: false, message: 'Không tìm thấy nhân sự' });
    }

    // Cập nhật thông tin
    if (displayName) user.displayName = displayName.trim();
    if (rank) user.rank = rank.trim();
    if (position) user.position = position.trim();

    // Avatar mới nếu upload
    if (req.file) {
      if (user.avatar && user.avatar.startsWith('/storage/avatars/')) {
        const oldPath = path.join(__dirname, '..', 'src/public', user.avatar);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      user.avatar = `/storage/avatars/${req.file.filename}`;
    }
// routes/admin.js
const express = require('express');
const router = express.Router();
const User = require('../models/User'); // điều chỉnh đường dẫn

router.get('/viewonduty', async (req, res) => {
  try {
    const users = await User.find().lean();
    const today = new Date().toLocaleDateString('en-US');

    let onDuty = 0, offToday = 0, notStarted = 0;
    users.forEach(user => {
      const record = (user.attendance || []).find(a => a.date === today);
      if (record && !record.offTime) onDuty++;
      else if (record) offToday++;
      else notStarted++;
    });

    res.render('admin-viewonduty', {
      users,
      stats: { onDuty, offToday, notStarted },
      currentUser: req.user || { displayName: 'Admin' }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Lỗi tải dữ liệu');
  }
});

module.exports = router;
    saveDB(db);

    // Ghi log
    addLog(req.session.user.username || 'Admin', 'CẬP NHẬT', user.displayName, 'Chỉnh sửa thông tin');

    res.json({ success: true, message: 'Cập nhật thành công!' });

  } catch (err) {
    console.error('Lỗi update user:', err);
    res.status(500).json({ success: false, message: 'Lỗi server khi cập nhật' });
  }
  // Trong app.js hoặc routes/admin.js
const express = require('express');
const router = express.Router();

// Giả sử bạn dùng router riêng cho admin
router.get('/admin-panel', (req, res) => {
  // Lấy dữ liệu users, stats từ DB
  // Ví dụ: res.render('admin-panel', { users: usersData, stats: statsData, currentUser: req.user });
  res.render('admin-panel', { 
    users: [], // thay bằng dữ liệu thật
    stats: { onDuty: 0, offToday: 0, notStarted: 0 },
    currentUser: req.user || { displayName: 'Admin' }
  });
});
// Khi modal salaryModal được mở
const salaryModal = document.getElementById('salaryModal');

salaryModal.addEventListener('show.bs.modal', function (event) {
    // Lấy thông tin từ nút bấm
    const button = event.relatedTarget;
    const userId = button.getAttribute('data-userid');
    const userName = button.getAttribute('data-name');

    // Cập nhật tên ngay lập tức
    document.getElementById('salaryTargetName').textContent = userName || 'Unknown';

    // Reset nội dung modal về trạng thái loading
    document.getElementById('totalHours').textContent = '0h';
    document.getElementById('ratePerHour').textContent = '$0/h';
    document.getElementById('totalSalary').textContent = '$0';
    document.getElementById('salaryDetailBody').innerHTML = `
        <tr><td colspan="5" class="text-center py-4">Đang tải dữ liệu...</td></tr>
    `;

    // Gọi API lấy lịch sử chấm công + lương
    fetch(`/payroll/history/${userId}`, {  // thay bằng endpoint thật của bạn
        method: 'GET',
        headers: {
            'Accept': 'application/json',
            // 'X-CSRF-TOKEN': 'your-csrf-token-here'   nếu cần
        }
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('Lỗi khi tải dữ liệu');
        }
        return response.json();
    })
    .then(data => {
        // data mong đợi dạng:
        // {
        //   thisMonth: { hours: 45.5, rate: 2.5, salary: 113750 },
        //   records: [ {date: "2026-01-01", checkin: "...", checkout: "...", hours: 8, salary: 20000}, ... ]
        // }

        // Cập nhật thống kê nhanh
        const hours = data.thisMonth?.hours?.toFixed(2) || 0;
        const rate = data.thisMonth?.rate?.toFixed(2) || 0;
        const salary = Number(data.thisMonth?.salary || 0).toLocaleString();

        document.getElementById('totalHours').textContent = `${hours} h`;
        document.getElementById('ratePerHour').textContent = `$${rate}/h`;
        document.getElementById('totalSalary').textContent = `$${salary}`;

        // Cập nhật bảng chi tiết
        const tbody = document.getElementById('salaryDetailBody');
        tbody.innerHTML = '';

        if (!data.records || data.records.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="text-center py-4 text-muted">
                        <i class="fa-solid fa-folder-open fa-2x mb-2 d-block text-secondary"></i>
                        Chưa có dữ liệu chấm công trong tháng này
                    </td>
                </tr>
            `;
            return;
        }

        // Có dữ liệu → render từng dòng
        data.records.forEach(record => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${record.date || '-'}</td>
                <td>${record.checkin || '-'}</td>
                <td>${record.checkout || '-'}</td>
                <td>${record.hours?.toFixed(2) || '0.00'} h</td>
                <td class="text-success">$${Number(record.salary || 0).toLocaleString()}</td>
            `;
            tbody.appendChild(row);
        });
    })
    .catch(error => {
        console.error('Lỗi tải lịch sử lương:', error);
        document.getElementById('salaryDetailBody').innerHTML = `
            <tr>
                <td colspan="5" class="text-center py-4 text-danger">
                    <i class="fa-solid fa-triangle-exclamation fa-2x mb-2 d-block"></i>
                    Không thể tải dữ liệu. Vui lòng thử lại sau.
                </td>
            </tr>
        `;
    });
});
// API: Lấy lịch sử chấm công của 1 user
app.get("/payroll/history/:userId", (req, res) => {
  const userId = parseInt(req.params.userId);
  const user = users.find(u => u.id === userId);

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  const rate = SALARY_RATES[user.position] || SALARY_RATES.default;
  const records = user.attendance || []; // giả lập: mảng [{date, checkin, checkout, hours, salary}]

  const totalHours = records.reduce((sum, r) => sum + (r.hours || 0), 0);
  const totalSalary = totalHours * rate;

  res.json({
    thisMonth: {
      hours: totalHours,
      rate,
      salary: totalSalary
    },
    records: records.map(r => ({
      ...r,
      salary: r.hours * rate
    }))
  });
});

// API: Cập nhật chức vụ (và tự động cập nhật lương)
app.post("/admin/update-position", (req, res) => {
  const { userId, newPosition } = req.body;
  const user = users.find(u => u.id === parseInt(userId));

  if (!user) return res.status(404).json({ error: "User not found" });

  user.position = newPosition;

  // Lương sẽ tự động tính lại khi render hoặc gọi API history
  res.json({ success: true, message: "Cập nhật chức vụ thành công" });
});
// Nếu dùng router riêng thì mount nó:
app.use('/', router); // hoặc app.use('/admin', adminRouter);
});
    console.log('=== DEBUG PAYROLL ===');
console.log('monthlyTotal:', monthlyTotal);
console.log('heSoLuong:', heSoLuong);
console.log('user:', targetUser?.username || 'không có user');
});
});


