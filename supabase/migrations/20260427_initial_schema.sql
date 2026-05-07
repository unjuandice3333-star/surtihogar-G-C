-- Crear tabla de negocios
CREATE TABLE IF NOT EXISTS businesses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Crear tabla de usuarios
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    role TEXT CHECK (role IN ('admin', 'empleado')) NOT NULL DEFAULT 'empleado',
    business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Crear tabla de categorías
CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    type TEXT CHECK (type IN ('income', 'expense')) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Crear tabla de transacciones
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type TEXT CHECK (type IN ('income', 'expense')) NOT NULL,
    amount NUMERIC(15, 2) NOT NULL,
    note TEXT, -- Campo opcional para notas
    date TIMESTAMPTZ DEFAULT NOW(), -- Fecha y hora del movimiento
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Datos Iniciales (Seed)
INSERT INTO businesses (name) VALUES 
('Electrodomésticos y celulares'),
('Muebles (salas)'),
('Ropa y electrodomésticos niños'),
('Billar y cervezas (arriendo)'),
('Local de ropa (arriendo)'),
('Droguería (arriendo)'),
('Edificio (baratillo + restaurante) (arriendo)')
ON CONFLICT DO NOTHING;

-- Seed de categorías iniciales
INSERT INTO categories (name, type) VALUES 
('Venta', 'income'),
('Arriendo', 'income'),
('Nómina', 'expense'),
('Servicios', 'expense'),
('Compra inventario', 'expense')
ON CONFLICT DO NOTHING;

-- --- Políticas de Seguridad (RLS) ---
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

-- Política para Usuarios: Los usuarios pueden ver su propio perfil
CREATE POLICY "Users can view own profile" ON users FOR SELECT USING (auth.uid() = id);

-- POLÍTICAS PARA NEGOCIOS
CREATE POLICY "Admins see all businesses" ON businesses FOR SELECT 
USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Employees see their business" ON businesses FOR SELECT 
USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND business_id = id));

-- POLÍTICAS PARA CATEGORÍAS (Todos pueden verlas)
CREATE POLICY "Everyone can view categories" ON categories FOR SELECT USING (true);

-- POLÍTICAS PARA TRANSACCIONES
-- 1. SELECT (Ver)
CREATE POLICY "Admins can view all transactions" ON transactions FOR SELECT 
USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Employees can view business transactions" ON transactions FOR SELECT 
USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND business_id = transactions.business_id));

-- 2. INSERT (Crear)
CREATE POLICY "Admins can insert any transaction" ON transactions FOR INSERT 
WITH CHECK (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Employees can insert in their business" ON transactions FOR INSERT 
WITH CHECK (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'empleado' AND business_id = transactions.business_id));

-- 3. UPDATE/DELETE (Admin Only)
CREATE POLICY "Admins can update/delete transactions" ON transactions FOR ALL 
USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

-- TABLA DE CATEGORÍAS DE INVENTARIO
CREATE TABLE IF NOT EXISTS inventory_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- TABLA DE PRODUCTOS (INVENTARIO)
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    category_id UUID REFERENCES inventory_categories(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    stock NUMERIC(15, 2) DEFAULT 0,
    purchase_price NUMERIC(15, 2) DEFAULT 0, -- PRECIO DE COMPRA (COSTO)
    sale_price NUMERIC(15, 2) DEFAULT 0,     -- PRECIO DE VENTA (CLIENTE)
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- TABLA DE MOVIMIENTOS DE INVENTARIO
CREATE TABLE IF NOT EXISTS inventory_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    type TEXT CHECK (type IN ('compra', 'venta', 'ajuste')) NOT NULL,
    quantity NUMERIC(15, 2) NOT NULL,
    unit_cost NUMERIC(15, 2) NOT NULL,
    total_cost NUMERIC(15, 2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    date TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Políticas RLS para Movimientos
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage movements" ON inventory_movements FOR ALL 
USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Employees manage their business movements" ON inventory_movements FOR ALL 
USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND business_id = inventory_movements.business_id));

-- Trigger para actualizar Stock e Impactar Finanzas automáticamente con Validación de Stock
CREATE OR REPLACE FUNCTION update_product_stock_and_finance()
RETURNS TRIGGER AS $$
DECLARE
    v_cat_id UUID;
    v_sale_price NUMERIC(15, 2);
    v_current_stock NUMERIC(15, 2);
BEGIN
    -- Obtener stock actual
    SELECT stock, sale_price INTO v_current_stock, v_sale_price FROM products WHERE id = NEW.product_id;

    -- 1. Validaciones y Actualización de Stock
    IF (NEW.type = 'compra') THEN
        UPDATE products SET stock = stock + NEW.quantity WHERE id = NEW.product_id;
        
        -- Crear Gasto (Compra Inventario)
        SELECT id INTO v_cat_id FROM categories WHERE name = 'Compra inventario' LIMIT 1;
        IF v_cat_id IS NOT NULL THEN
            INSERT INTO transactions (type, amount, category_id, business_id, user_id, date, note)
            VALUES ('expense', NEW.total_cost, v_cat_id, NEW.business_id, NEW.user_id, NEW.date, 'Compra: ' || (SELECT name FROM products WHERE id = NEW.product_id));
        END IF;

    ELSIF (NEW.type = 'venta') THEN
        -- REGLA: No permitir ventas sin stock
        IF (v_current_stock - NEW.quantity < 0) THEN
            RAISE EXCEPTION 'Stock insuficiente para esta venta. Disponible: %', v_current_stock;
        END IF;

        UPDATE products SET stock = stock - NEW.quantity WHERE id = NEW.product_id;
        
        -- Crear Ingreso (Venta)
        SELECT id INTO v_cat_id FROM categories WHERE name = 'Venta' LIMIT 1;
        IF v_cat_id IS NOT NULL THEN
            INSERT INTO transactions (type, amount, category_id, business_id, user_id, date, note)
            VALUES ('income', v_sale_price * NEW.quantity, v_cat_id, NEW.business_id, NEW.user_id, NEW.date, 'Venta: ' || (SELECT name FROM products WHERE id = NEW.product_id));
        END IF;

    ELSIF (NEW.type = 'ajuste') THEN
        UPDATE products SET stock = NEW.quantity WHERE id = NEW.product_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Borrar trigger anterior si existe y crear el nuevo
DROP TRIGGER IF EXISTS trg_update_stock ON inventory_movements;
CREATE TRIGGER trg_update_stock_finance
AFTER INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION update_product_stock_and_finance();

-- Índices
CREATE INDEX IF NOT EXISTS idx_inventory_categories_bus ON inventory_categories(business_id);
CREATE INDEX IF NOT EXISTS idx_products_bus ON products(business_id);
CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_prod ON inventory_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_bus ON inventory_movements(business_id);

-- TABLA DE LOGS DE SISTEMA (ACTUALIZADA)
CREATE TABLE IF NOT EXISTS system_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT CHECK (type IN ('error', 'warning', 'info')) DEFAULT 'info',
    module TEXT CHECK (module IN ('finanzas', 'inventario', 'auth', 'sistema')) NOT NULL,
    message TEXT NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- RLS para Logs (Solo Admins)
ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Only admins can see logs" ON system_logs FOR SELECT 
USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "All users can insert logs" ON system_logs FOR INSERT 
WITH CHECK (true);


-- REGLAS DE INTEGRIDAD PARA TRANSACCIONES
ALTER TABLE transactions ADD CONSTRAINT check_positive_amount CHECK (amount > 0);
ALTER TABLE transactions ALTER COLUMN category_id SET NOT NULL;

-- FUNCI�N PARA SINCRONIZAR AUTH.USERS CON PUBLIC.USERS Y ASIGNAR ADMIN AL PRIMERO
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS 
DECLARE
    v_role TEXT := 'empleado';
BEGIN
    -- Si no hay usuarios en la tabla, el primero es admin
    IF NOT EXISTS (SELECT 1 FROM public.users) THEN
        v_role := 'admin';
    END IF;

    INSERT INTO public.users (id, name, email, role)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'name', 'Usuario Nuevo'),
        NEW.email,
        v_role
    );
    RETURN NEW;
END;
 LANGUAGE plpgsql SECURITY DEFINER;

-- TRIGGER DE AUTH
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
