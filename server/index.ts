import express, { Application } from "express";
import http, { Server } from "http";
import { Server as IOServer, Socket } from "socket.io";
import cors from "cors";
import { PrismaClient } from "./generated/prisma";

export class SocketServer {
    private app: Application;
    private httpServer: Server;
    private io: IOServer;
    private prisma = new PrismaClient();

    private readonly PORT = Number(process.env.PORT || 3000);

    // таймеры
    private typingTimers = new Map<string, NodeJS.Timeout>();
    private awayTimers = new Map<string, NodeJS.Timeout>();
    private lastMessageMap = new Map<string, { text: string; ts: number }>();

    // Сервер
    constructor() {
        this.app = express();
        this.httpServer = http.createServer(this.app);
        this.io = new IOServer(this.httpServer, {
            cors: { origin: "*", methods: ["GET", "POST"] }
        });

        this.app.use(cors());

        this.configureRoutes();
        this.configureSocketEvents();
        this.start();
    }

    private configureRoutes() {
        this.app.get("/", (_req, res) => res.send("Hello World!"));
    }

    // Поиск @
    private extractionMentions (text: string) {
        const pattern = /@([a-zA-Z0-9_]+)/g;
        const names = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            if (match[1]) names.add(match[1]);
        }
        return Array.from(names);
    }

    // Сброс "отошел"
    private async resetAway(username: string) {
        if (!username) return;

        const previousTimer = this.awayTimers.get(username);
        if (previousTimer) clearTimeout(previousTimer);

        const timer = setTimeout(async () => {
            await this.prisma.user.updateMany({
                where: { username },
                data: { status: "away" }
            });
            this.io.emit("userStatusChanged", { username, status: "away" });
            this.awayTimers.delete(username);
        }, 60000);

        this.awayTimers.set(username, timer);
    }

    private configureSocketEvents() {
        this.io.on("connection", (socket: Socket) => {
            console.log("socket: connected", socket.id);
            socket.data.username = null;

            // События
            socket.on("login", (data) => 
                this.loginUser(socket, data));
            socket.on("createRoom", (data) => 
                this.createRoom(socket, data));
            socket.on("joinRoom", (data) => 
                this.joinRoom(socket, data));
            socket.on("leaveRoom", (data) => 
                this.leaveRoom(socket, data));
            socket.on("typing", (data) => 
                this.typing(socket, data));
            socket.on("message", (data) => 
                this.message(socket, data));
            socket.on("likeMessage", (data) => 
                this.likeMessage(socket, data));
            socket.on("logout", (username) => 
                this.logout(socket, username));
            socket.on("disconnect", (reason) => 
                this.disconnect(socket, reason));
        });
    }

    // Авторизация
    private async loginUser(socket: Socket, data: { user: string; roomName?: string }) {
        try {
            const username = data.user;
            socket.data.username = username;
            socket.join(`user:${username}`);

            // Создание юзера
            const user = await this.prisma.user.upsert({
                where: { username },
                update: { status: "online", nowRoom: data.roomName ?? null },
                create: { username, status: "online", nowRoom: data.roomName ?? null }
            });

            // Присоединение к комнате если есть
            if (data.roomName) {
                const room = await this.prisma.room.findUnique({ where: { name: data.roomName } });

                // Для приватных комнат
                if (room?.isPrivate) {
                    const allowedUsers = (room.allowedUsers ?? "").split(",").map(user => user.trim());
                    const invite = await this.prisma.roomInvite.findFirst({
                        where: { roomId: room.id, invitee: username }
                    });

                    if (!allowedUsers.includes(username) && !invite) {
                        socket.emit("errorMessage", { message: "У вас нет доступа в приватную комнату" });
                    } else {
                        socket.join(data.roomName);
                    }
                } else {
                    // Публичная комната
                    if (!room) {
                        const newRoom = await this.prisma.room.create({
                            data: { name: data.roomName, isPrivate: false }
                        });
                        this.io.emit("roomCreated", { name: newRoom.name, isPrivate: newRoom.isPrivate });
                    }
                    socket.join(data.roomName);
                }
            }

            // Оффлайн-сообщения
            const dbUser = await this.prisma.user.findUnique({ where: { username } });

            if (dbUser) {
                const unreadMessages = await this.prisma.unreadMessage.findMany({
                    where: { userId: dbUser.id },
                    include: { message: { include: { user: true, room: true } } }
                });

                if (unreadMessages.length) {
                    socket.emit("offlineMessages", unreadMessages.map(unread => ({
                        id: unread.messageId,
                        text: unread.message.text,
                        from: unread.message.user.username,
                        room: unread.message.room.name,
                        createdAt: unread.message.createdAt
                    })));

                    await this.prisma.unreadMessage.deleteMany({ where: { userId: dbUser.id } });
                }
            }

            // Уведомение об онлайне
            this.io.emit("userStatusChanged", { username, status: "online", nowRoom: data.roomName ?? null });

            // Данные о присоединении
            socket.emit("joinedRoom", {
                roomName: data.roomName ?? null,
                role: user.role ?? 1,
                isMuted: user.isMuted ?? false
            });

            // Список пользователей в комнате
            if (data.roomName) {
                const users = await this.prisma.user.findMany({ where: { nowRoom: data.roomName } });
                socket.emit("roomUsers", users.map(user => ({
                    username: user.username,
                    status: user.status,
                    role: user.role,
                    isMuted: user.isMuted
                })));
            }

            await this.resetAway(username);
        } catch (err) {
            console.error(err);
            socket.emit("errorMessage", { message: "Ошибка логина" });
        }
    }

    // Создание комнаты
    private async createRoom(socket: Socket, data: { roomName: string; type: "private" | "public"; members?: string[]; inviter?: string }) {
        const exists = await this.prisma.room.findUnique({ where: { name: data.roomName } });
        if (exists) return socket.emit("errorMessage", { message: "Комната уже существует" });

        const room = await this.prisma.room.create({
            data: {
                name: data.roomName,
                isPrivate: data.type === "private",
                allowedUsers: (data.members ?? []).join(",")  // Список разрешенных пользователей
            }
        });

        // Приглашения
        if (data.type === "private" && data.members) {
            for (const member of data.members) {
                await this.prisma.roomInvite.create({
                    data: { roomId: room.id, invitee: member, inviter: data.inviter ?? "DefaultUser" }
                });
            }
        }

        this.io.emit("roomCreated", { name: room.name, isPrivate: room.isPrivate });
    }

    // Присоединение к комнате
    private async joinRoom(socket: Socket, data: { user: string; room: string }) {
        const room = await this.prisma.room.findUnique({ where: { name: data.room } });
        if (!room) return socket.emit("errorMessage", { message: "Такой комнаты не существует" });

        // Проверка доступа к приватной комнате
        if (room.isPrivate) {
            const allowedUsers = (room.allowedUsers ?? "").split(",").map(user => user.trim());
            const invite = await this.prisma.roomInvite.findFirst({
                where: { roomId: room.id, invitee: data.user }
            });

            if (!allowedUsers.includes(data.user) && !invite) {
                return socket.emit("errorMessage", { message: "Нет доступа" });
            }
        }

        socket.join(data.room);
        await this.prisma.user.updateMany({
            where: { username: data.user },
            data: { nowRoom: data.room, status: "online" }
        });

        // Уведомление о участнике
        this.io.to(data.room).emit("roomMessage", { message: `${data.user} присоединился` });
        this.io.emit("userStatusChanged", { username: data.user, status: "online", nowRoom: data.room });
        this.resetAway(data.user);
    }

    // Выход из комнаты
    private async leaveRoom(socket: Socket, data: { user: string; room?: string }) {
        const username = data.user;
        const roomName = data.room ?? [...socket.rooms].find(room => !room.startsWith("user:") && room !== socket.id);
        if (!roomName) return;

        socket.leave(roomName);
        await this.prisma.user.updateMany({ where: { username }, data: { nowRoom: null } });
        this.io.to(roomName).emit("roomMessage", { message: `${username} вышел из комнаты` });
        this.io.emit("userStatusChanged", { username, status: "online", nowRoom: null });
    }

    private async typing(_socket: Socket, data: { user: string }) {
        const username = data.user;

        // Сброс таймера
        if (this.typingTimers.has(username)) {
            clearTimeout(this.typingTimers.get(username)!);
            this.typingTimers.delete(username);
        }

        await this.prisma.user.updateMany({ where: { username }, data: { status: "typing" } });
        this.io.emit("userStatusChanged", { username, status: "typing" });

        const timer = setTimeout(async () => {
            await this.prisma.user.updateMany({ where: { username }, data: { status: "online" } });
            this.io.emit("userStatusChanged", { username, status: "online" });
            this.typingTimers.delete(username);
        }, 3000);

        this.typingTimers.set(username, timer);
        this.resetAway(username);
    }

    // Отправка сообщения
    private async message(socket: Socket, data: { user: string; room: string; text: string }) {
        const username = data.user;
        const text = data.text.trim();
        if (!text) return socket.emit("errorMessage", { message: "Пустое сообщение" });

        // Антиспам
        const lastMessage = this.lastMessageMap.get(username);
        const now = Date.now();
        if (lastMessage && lastMessage.text === text && now - lastMessage.ts < 5000) {
            return socket.emit("errorMessage", { message: "Нельзя спамить!" });
        }

        this.lastMessageMap.set(username, { text, ts: now });

        const dbUser = await this.prisma.user.findUnique({ where: { username } });
        const dbRoom = await this.prisma.room.findUnique({ where: { name: data.room } });
        if (!dbUser || !dbRoom) return;

        // Пред
        if (dbUser.isMuted) return socket.emit("errorMessage", { message: "Вам ничего нельзя" });

        const mentions = this.extractionMentions (text);
        const message = await this.prisma.message.create({
            data: {
                text,
                userId: dbUser.id,
                roomId: dbRoom.id,
                mentions: mentions.join(",")
            },
            include: { user: true, room: true }
        });

        // Отправка сообщения в комнату
        this.io.to(data.room).emit("roomMessage", {
            id: message.id,
            text,
            from: dbUser.username,
            createdAt: message.createdAt,
            mentions
        });

        const users = await this.prisma.user.findMany({ where: { nowRoom: data.room } });
        // Уведомления об упоминаниях
        for (const user of users) {
            if (user.username === username) continue;
            if (user.status === "offline") {
                await this.prisma.unreadMessage.create({
                    data: { messageId: message.id, userId: user.id }
                });
                this.io.to(`user:${user.username}`).emit("newOfflineMessageNotification", { from: username, room: data.room });
            }
        }

        for (const mention of mentions) {
            this.io.to(`user:${mention}`).emit("mentionNotification", { from: username, room: data.room, text });
        }

        this.resetAway(username);
    }

    // Лайк сообщения
    private async likeMessage(_socket: Socket, data: { user: string; messageId?: string }) {

        if (!data.messageId) {
            return;
        }

        const user = await this.prisma.user.findUnique({
            where: { username: data.user }
        });
        if (!user) return;

        const existingLike = await this.prisma.messageLike.findFirst({
            where: { messageId: data.messageId, userId: user.id }
        });

        if (existingLike) {
            await this.prisma.messageLike.delete({ where: { id: existingLike.id } });
        } else {
            await this.prisma.messageLike.create({
                data: {
                    messageId: data.messageId,
                    userId: user.id
                }
            });
        }

        const likes = await this.prisma.messageLike.findMany({
            where: { messageId: data.messageId },
            include: { user: true }
        });

        this.io.emit("messageLiked", {
            messageId: data.messageId,
            likesCount: likes.length,
            likedBy: likes.map(like => like.user.username)
        });
    }

    // Выход из системы
    private async logout(socket: Socket, username: string) {
        await this.prisma.user.updateMany({ where: { username }, data: { status: "offline", nowRoom: null } });
        this.io.emit("userStatusChanged", { username, status: "offline" });

        for (const room of socket.rooms) {
            if (!room.startsWith("user:") && room !== socket.id) {
                socket.leave(room);
                this.io.to(room).emit("roomMessage", { message: `${username} вышел из комнаты` });
            }
        }
    }

    // Отключение
    private async disconnect(socket: Socket, reason: string) {
        const username = socket.data.username;
        if (username) {
            await this.prisma.user.updateMany({ where: { username }, data: { status: "offline", nowRoom: null } });
            this.io.emit("userStatusChanged", { username, status: "offline" });
        }
    }

    // Запуск сервера
    private start() {
        this.httpServer.listen(this.PORT, () =>
            console.log(`Server running on port: ${this.PORT}`)
        );
    }
}

new SocketServer();