const socket = io("http://localhost:3000");

// Окна
const loginWindow = document.getElementById("login");
const chatWindow = document.getElementById("chat");
const roomCreateWindow = document.getElementById("room-create");
const membersWindow = document.getElementById("members");
const actionsWindow = document.getElementById("room-actions");
const chatNotice = document.getElementById("chat__notice");

// Элементы
const loginInput = document.getElementById("login__input");
const loginButton = document.getElementById("login__button");
const chatExitButton = document.getElementById("chat__exit");
const openRoomCreateWindowButton = document.getElementById("chat__add-room");
const roomCreateButton = document.getElementById("room-create__submit");
const closeRoomCreateWindowButton = document.getElementById("room-create__close");
const openMembersWindowButton = document.getElementById("chat__room-members");
const closeMembersWindowButton = document.getElementById("members__close");
const sendMessageButton = document.getElementById("chat__send");
const joinRoomButton = document.getElementById("chat-room__join");
const leaveRoomButton = document.getElementById("chat-room__leave");
const joinOrLeaveButton = document.getElementById("room-actions__submit");
const closeActionsWindowButton = document.getElementById("room-actions__close");
const chatRoomElement = document.getElementById("chat-room");
const reaction = document.getElementById("message__reaction");
const messageInput = document.getElementById("chat__message-input");
const messagesContainer = document.querySelector(".chat__messages");

let currentUser = null;
let currentRoom = null;
let typingTimer = null;

// Добавление сообщения
function appendMessage(message) {
    const container = document.createElement("div");
    container.className = "message-item";
    container.dataset.id = message.id || ("sys-" + Date.now());

    const messageContent = document.createElement("div");
    messageContent.className = "message-content";
    messageContent.style.display = "flex";
    messageContent.style.alignItems = "center";
    messageContent.style.gap = "8px";

    const sender = document.createElement("div");
    sender.className = "message__sender";
    sender.textContent = (message.from ? message.from : "DefaultUser") + ":";

    const text = document.createElement("div");
    text.className = "message__text";
    const html = (message.text || "").replace(/@([a-zA-Z0-9_]+)/g, (match, name) => `<span class="mention">@${name}</span>`);
    text.innerHTML = html;

    const reactionWrap = document.createElement("div");
    reactionWrap.className = "message__reaction-wrap";
    reactionWrap.innerHTML = `<div class="message__reaction" data-id="${container.dataset.id}" style="color: #ff548e; display: flex; align-items: center; gap: 4px;">❤<span class="like-count"></span></div>`;

    messageContent.appendChild(sender);
    messageContent.appendChild(text);
    messageContent.appendChild(reactionWrap);
    
    container.appendChild(messageContent);
    messagesContainer.appendChild(container);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    const reactionBtn = container.querySelector(".message__reaction");
    reactionBtn.addEventListener("click", () => {
        const messageId = message.id;
        socket.emit("likeMessage", { user: currentUser, messageId });
        console.log("client: likeMessage", messageId);
    });
}

// Авторизация
loginButton.addEventListener("click", () => {
    const username = loginInput.value.trim();
    if (!username) return alert("Введите username");
    
    currentUser = username;
    loginWindow.style.display = "none";
    chatWindow.style.display = "flex";
    chatNotice.style.display = "flex";
    
    socket.emit("login", { user: currentUser });
    console.log("client: emit login", currentUser);
});

// Выход из чата
chatExitButton.addEventListener("click", () => {
    if (currentUser) socket.emit("logout", currentUser);
    
    chatWindow.style.display = "none";
    loginWindow.style.display = "flex";
    console.log("client: logout", currentUser);
    
    currentUser = null;
    currentRoom = null;
});

// Открытие окна создания комнаты
openRoomCreateWindowButton.addEventListener("click", () => {
    roomCreateWindow.style.display = "flex";
});

// Создание комнаты
roomCreateButton.addEventListener("click", () => {
    const roomName = document.getElementById("room-create__name").value.trim();
    const roomType = document.querySelector('input[name="room-type"]:checked')?.value;
    const members = document.getElementById("room-create__members").value.split(",").map(member => member.trim()).filter(Boolean);
    
    if (!roomName || !roomType) return alert("Введите все поля");
    
    socket.emit("createRoom", { 
        roomName: roomName, 
        type: roomType === "private" ? "private" : "public", 
        members, 
        inviter: currentUser 
    });
    
    roomCreateWindow.style.display = "none";
    console.log("client: createRoom", roomName, roomType, members);
});

// Закрытие окна создания комнаты
closeRoomCreateWindowButton.addEventListener("click", () => {
    roomCreateWindow.style.display = "none";
});

// Открытие окна списка участников
openMembersWindowButton.addEventListener("click", () => {
    membersWindow.style.display = "flex";
});

// Закрытие окна списка участников
closeMembersWindowButton.addEventListener("click", () => {
    membersWindow.style.display = "none";
});

// Открытие окна действий (вход/выход из комнаты)
joinRoomButton.addEventListener("click", () => { 
    actionsWindow.style.display = "flex"; 
});

// Открытие окна действий (вход/выход из комнаты)
leaveRoomButton.addEventListener("click", () => { 
    actionsWindow.style.display = "flex"; 
});

// Закрытие окна действий (вход/выход из комнаты)
closeActionsWindowButton.addEventListener("click", () => { 
    actionsWindow.style.display = "none"; 
});

// Вход или выход из комнаты
joinOrLeaveButton.addEventListener("click", () => {
    const action = document.querySelector('input[name="room-actions-type"]:checked')?.value;
    const roomName = document.getElementById("room-actions__input").value.trim();
    
    if (!action || !roomName) return alert("Заполните инпут");
    
    if (action === "join") {
        socket.emit("joinRoom", { user: currentUser, room: roomName });
        currentRoom = roomName;
        document.getElementById("chat__room-name").textContent = roomName;
        chatNotice.style.display = "none";
        console.log("client: joinRoom", roomName);
    } else {
        socket.emit("leaveRoom", { user: currentUser, room: roomName });
        console.log("client: leaveRoom", roomName);
        if (currentRoom === roomName) currentRoom = null;
    }
    
    actionsWindow.style.display = "none";
});

// Скрытие уведомления
chatRoomElement.addEventListener("click", () => {
    chatNotice.style.display = "none";
});

// Отправка сообщения
sendMessageButton.addEventListener("click", () => {
    const messageText = messageInput.value.trim();
    if (!messageText) return;
    if (!currentRoom) return alert("Сначала присоединитесь к комнате");
    if (messageText.length > 300) return alert("Сообщение слишком большое");
    
    socket.emit("message", { user: currentUser, room: currentRoom, text: messageText });
    messageInput.value = "";
    console.log("client: message sent");
});

// Набор сообщения
messageInput.addEventListener("input", () => {
    if (!currentUser || !currentRoom) return;
    
    socket.emit("typing", { user: currentUser, room: currentRoom });
    
    // Таймер для остановки индикатора
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        socket.emit("typing", { user: currentUser, room: currentRoom });
    }, 1000);
});

// Лайк
if (reaction) {
    reaction.addEventListener("click", () => {
        reaction.style.color = reaction.style.color === "rgb(255, 84, 142)" ? "" : "#ff548e";
    });
}

// Офлайн-сообщения
socket.on("offlineMessages", (messages) => {
    console.log("socket: offlineMessages", messages);
    alert(`У вас ${messages.length} офлайн сообщений`);
    messages.forEach(message => appendMessage({ 
        id: message.id, 
        text: message.text, 
        from: message.from, 
        createdAt: message.createdAt 
    }));
});

// Новое сообщение
socket.on("roomMessage", (messageData) => {
    console.log("socket: roomMessage", messageData);
    appendMessage(messageData);
});

// Присоединение к комнате
socket.on("joinedRoom", (roomInfo) => {
    console.log("socket: joinedRoom", roomInfo);
    if (roomInfo.roomName) {
        currentRoom = roomInfo.roomName;
        document.getElementById("chat__room-name").textContent = roomInfo.roomName;
    }
});

// Обновление списка пользователей в комнате
socket.on("roomUsers", (users) => {
    console.log("socket: roomUsers", users);
    document.getElementById("chat__room-members").textContent = "Members: " + (users?.length ?? 0);
});

// Изменение статуса пользователя
socket.on("userStatusChanged", (userData) => {
    console.log("socket: userStatusChanged", userData);
});

// Уведомление об упоминании
socket.on("mentionNotification", (notification) => {
    console.log("socket: mentionNotification", notification);
    alert(`Вас упомянул ${notification.from} в ${notification.room}`);
});

// Обновление лайков сообщения
socket.on("messageLiked", (likeData) => {
    console.log("socket: messageLiked", likeData);
    const messageElement = document.querySelector(`[data-id="${likeData.messageId}"]`);
    if (messageElement) {
        const likeCountElement = messageElement.querySelector(".like-count");
        if (likeCountElement) likeCountElement.textContent = ` ${likeData.likesCount}`;
    }
});

// Ошибки от сервера
socket.on("errorMessage", (errorData) => {
    console.log("socket: errorMessage", errorData);
    alert(errorData.message || "Ошибка");
});

// Создание новой комнаты
socket.on("roomCreated", (room) => {
    console.log("socket: roomCreated", room);
});

// Уведомление о новом офлайн-сообщении
socket.on("newOfflineMessageNotification", (notification) => {
    console.log("socket: newOfflineMessageNotification", notification);
    alert(`Новое офлайн сообщение от ${notification.from} в ${notification.room}`);
});